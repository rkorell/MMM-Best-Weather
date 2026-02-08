/**
 * @file node_helper.js
 * @author Dr. Ralf Korell (2025)
 * @license MIT
 * @description Node helper for MMM-Best-Weather. Handles fetching weather data from Open-Meteo,
 *              calculating an HCI-adapted "best weather" score for multiple cities, determining the TOP1 city,
 *              and dynamically calculating the update interval based on API limits.
 *
 * @changelog
 *   2025-09-28 15:10 UTC: Added module header and translated comments to English.
 *                        Implemented dynamic update interval calculation based on 'openmeteoMaxQueriesPerDay'.
 *                        Defined MIN_UPDATE_INTERVAL and MAX_UPDATE_INTERVAL constants.
 *                        The calculated interval is now sent to the main module.
 *   2025-09-28 15:15 UTC: Adjusted dynamic update interval calculation to round down to the nearest multiple of 10
 *                        for 'updatesPerDay' to provide a more conservative buffer against API limits.
 *   2025-09-28 15:25 UTC: Refined the log message for the dynamic update interval calculation to include
 *                        Max Queries, City Count, calculated Update Interval, and Resulting Number of Queries.
 *   2025-09-28 16:00 UTC: Implemented statistics file writing:
 *                        - Added 'humidity', 'cloudCover', 'precipitation', 'windSpeed' to internal 'top1CityData' for logging.
 *                        - Writes TOP1 city data to a CSV file (append mode) if 'statisticsFileName' is configured.
 *                        - Includes timestamp, city name, weather code, temperature, humidity, cloud cover, precipitation, wind speed, and score.
 *                        - Writes header row only if file is newly created.
 *                        - Implemented error handling for file operations.
 *   2026-02-08 13:30 UTC: Replaced linear score formula with HCI-adapted scoring
 *                        (Gaussian thermal comfort, cloud aesthetic, physical precipitation/wind, WC override).
 *                        Added apparent_temperature to API call. Extended CSV format with sub-scores.
 */

const NodeHelper = require("node_helper");
const fetch = require("node-fetch"); // For API requests
const SunCalc = require("suncalc"); // For sunrise/sunset calculations
const fs = require("fs").promises; // For reading/writing file content

// Constants for minimum and maximum update intervals (in milliseconds)
const MIN_UPDATE_INTERVAL = 60 * 1000; // 1 minute
const MAX_UPDATE_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

module.exports = NodeHelper.create({
    // Store the loaded city data
    cities: [],

    start: async function() {
        console.log("MMM-Best-Weather: Starting node_helper for MMM-Best-Weather.");
        try {
            const citiesFilePath = this.path + "/cities.json";
            const citiesData = await fs.readFile(citiesFilePath, "utf8");
            this.cities = JSON.parse(citiesData);
        } catch (error) {
            console.error("MMM-Best-Weather: Error loading cities.json:", error);
            this.sendSocketNotification("WEATHER_ERROR", `MMM-Best-Weather: Failed to load cities.json: ${error.message}`);
        }
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "FETCH_WEATHER") {
            this.fetchWeatherData(payload);
        }
    },

    fetchWeatherData: async function(config) {
        if (this.cities.length === 0) {
            console.error("MMM-Best-Weather: No cities loaded. Cannot fetch weather data.");
            this.sendSocketNotification("WEATHER_ERROR", "MMM-Best-Weather: No cities loaded for weather fetch.");
            return;
        }

        // 1. Prepare latitudes and longitudes for the Open-Meteo API
        const latitudes = this.cities.map(city => city.lat).join(",");
        const longitudes = this.cities.map(city => city.lon).join(",");

        // 2. Construct the Open-Meteo API URL (with apparent_temperature for HCI scoring)
        const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitudes}&longitude=${longitudes}&current=temperature_2m,apparent_temperature,weathercode,precipitation,cloud_cover,relative_humidity_2m,wind_speed_10m`;

        let openMeteoResponse;
        try {
            const response = await fetch(openMeteoUrl);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Open-Meteo API error: ${response.statusText} - ${errorText}`);
            }
            openMeteoResponse = await response.json();
        } catch (error) {
            console.error("MMM-Best-Weather: Error fetching Open-Meteo data for all cities:", error);
            this.sendSocketNotification("WEATHER_ERROR", `MMM-Best-Weather: Open-Meteo multi-city fetch error: ${error.message}`);
            return;
        }

        // 3. HCI-adapted score calculation and determination of the TOP1 city
        let bestScore = -Infinity;
        let top1CityData = null;

        if (Array.isArray(openMeteoResponse) && openMeteoResponse.length === this.cities.length) {
            const numCities = this.cities.length;

            // HCI configuration parameters with defaults
            const tOpt = config.tOpt !== undefined ? config.tOpt : 22;
            const sigma = config.sigma !== undefined ? config.sigma : 10;
            const wcOverrides = config.wcOverrides || {};

            for (let i = 0; i < numCities; i++) {
                const city = this.cities[i];
                const cityWeatherResponse = openMeteoResponse[i];

                // Check if the weather response for this city is valid
                if (!cityWeatherResponse || !cityWeatherResponse.current || cityWeatherResponse.current.temperature_2m === undefined) {
                    console.warn(`MMM-Best-Weather: Missing 'current' data for city index ${i} (${city.city}). Skipping.`);
                    continue;
                }

                // Extract weather data
                const temp = cityWeatherResponse.current.temperature_2m;
                const apparentTemp = cityWeatherResponse.current.apparent_temperature;
                const weatherCode = cityWeatherResponse.current.weathercode;
                const precipitation = cityWeatherResponse.current.precipitation;
                const cloudCover = cityWeatherResponse.current.cloud_cover;
                const humidity = cityWeatherResponse.current.relative_humidity_2m;
                const windSpeed = cityWeatherResponse.current.wind_speed_10m;

                // --- Thermal Comfort (40%) — Gaussian bell curve around T_opt ---
                const TC = 10 * Math.exp(-0.5 * Math.pow((apparentTemp - tOpt) / sigma, 2));

                // --- Aesthetic (20%) — Cloud cover rating (research: 10-20% optimal) ---
                let A;
                if (cloudCover <= 20) {
                    A = 9 + cloudCover / 20;
                } else if (cloudCover <= 50) {
                    A = 10 - (cloudCover - 20) * 0.1;
                } else {
                    A = 7 - (cloudCover - 50) * 0.1;
                }

                // --- Physical (40%) — Precipitation + Wind, worse value dominates ---
                const pRain = Math.max(0, Math.min(10, 10 - precipitation * 3));
                const pWind = Math.max(0, Math.min(10, 10 - windSpeed * 0.2));
                const P = Math.min(pRain, pWind);

                // --- Weather Code Override (multiplier) ---
                const wcOverride = this.getWeatherCodeOverride(weatherCode, wcOverrides);

                // --- HCI Score (0-100) ---
                const score = (0.4 * TC + 0.2 * A + 0.4 * P) * 10 * wcOverride;

                if (score > bestScore) {
                    bestScore = score;
                    top1CityData = {
                        name: city.city,
                        temperature: temp,
                        apparentTemperature: apparentTemp,
                        weatherCode: weatherCode,
                        latitude: city.lat,
                        longitude: city.lon,
                        score: score,
                        // Sub-scores for statistics
                        tc: TC,
                        aesthetic: A,
                        physical: P,
                        wcOverride: wcOverride,
                        // Raw data for statistics
                        humidity: humidity,
                        cloudCover: cloudCover,
                        precipitation: precipitation,
                        windSpeed: windSpeed
                    };
                }
            }
        } else {
            console.error("MMM-Best-Weather: Open-Meteo response is not an array or length mismatch with cities.json.");
            this.sendSocketNotification("WEATHER_ERROR", "MMM-Best-Weather: Open-Meteo: Invalid response structure.");
            return;
        }

        // 4. Determine day or night for the TOP1 city
        let isDayForTop1 = true;
        if (top1CityData && top1CityData.latitude !== null && top1CityData.longitude !== null) {
            const now = new Date();
            const times = SunCalc.getTimes(now, top1CityData.latitude, top1CityData.longitude);
            isDayForTop1 = now > times.sunrise && now < times.sunset;
        } else {
            console.warn("MMM-Best-Weather: Could not determine day/night for TOP1 city. Defaulting to day.");
        }

        // 5. Calculate dynamic update interval
        const openmeteoMaxQueriesPerDay = config.openmeteoMaxQueriesPerDay || 5000;
        const numCitiesToQuery = this.cities.length;

        let calculatedUpdateIntervalMs;
        let resultingUpdatesPerDay = 0;
        let resultingNumberOfQueriesPerDay = 0;

        if (numCitiesToQuery > 0) {
            let updatesPerDayCandidate = Math.floor(openmeteoMaxQueriesPerDay / numCitiesToQuery);
            updatesPerDayCandidate = Math.floor(updatesPerDayCandidate / 10) * 10;
            if (updatesPerDayCandidate === 0) {
                updatesPerDayCandidate = 1;
            }
            resultingUpdatesPerDay = updatesPerDayCandidate;

            const totalMinutesInDay = 24 * 60;
            const intervalInMinutes = totalMinutesInDay / resultingUpdatesPerDay;
            calculatedUpdateIntervalMs = intervalInMinutes * 60 * 1000;

            resultingNumberOfQueriesPerDay = resultingUpdatesPerDay * numCitiesToQuery;
        } else {
            console.warn("MMM-Best-Weather: No cities configured. Using MAX_UPDATE_INTERVAL.");
            calculatedUpdateIntervalMs = MAX_UPDATE_INTERVAL;
            resultingUpdatesPerDay = 0;
            resultingNumberOfQueriesPerDay = 0;
        }

        calculatedUpdateIntervalMs = Math.max(MIN_UPDATE_INTERVAL, calculatedUpdateIntervalMs);
        calculatedUpdateIntervalMs = Math.min(MAX_UPDATE_INTERVAL, calculatedUpdateIntervalMs);

        // 6. Write statistics to file if configured
        if (config.statisticsFileName && top1CityData) {
            const statsFilePath = this.path + "/" + config.statisticsFileName;
            const now = new Date();
            const timestamp = `${now.getDate().toString().padStart(2, '0')}.${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

            // Extended CSV line with sub-scores
            const csvLine = `${timestamp};${top1CityData.name};${top1CityData.weatherCode};${top1CityData.temperature};${top1CityData.apparentTemperature};${top1CityData.humidity};${top1CityData.cloudCover};${top1CityData.precipitation};${top1CityData.windSpeed};${top1CityData.tc.toFixed(2)};${top1CityData.aesthetic.toFixed(2)};${top1CityData.physical.toFixed(2)};${top1CityData.wcOverride.toFixed(2)};${top1CityData.score.toFixed(1)}\n`;

            try {
                const fileExists = await fs.access(statsFilePath, fs.constants.F_OK)
                    .then(() => true)
                    .catch(() => false);

                if (!fileExists) {
                    const header = "Timestamp;City;WeatherCode;Temperature;ApparentTemperature;Humidity;CloudCover;Precipitation;WindSpeed;TC;A;P;WC_Override;Score\n";
                    await fs.writeFile(statsFilePath, header, { encoding: 'utf8' });
                }
                await fs.appendFile(statsFilePath, csvLine, { encoding: 'utf8' });
            } catch (error) {
                console.error(`MMM-Best-Weather: Error writing statistics to file ${statsFilePath}:`, error);
            }
        }

        // 7. Send the TOP1 city data and the calculated update interval to the main module
        if (top1CityData) {
            const weatherData = {
                cityName: top1CityData.name,
                temperature: top1CityData.temperature,
                apparentTemperature: top1CityData.apparentTemperature,
                weatherCode: top1CityData.weatherCode,
                score: top1CityData.score,
                isDay: isDayForTop1,
                weatherIconClass: this.getWeatherIcon(top1CityData.weatherCode, isDayForTop1),
                calculatedUpdateIntervalMs: calculatedUpdateIntervalMs
            };
            this.sendSocketNotification("WEATHER_DATA", weatherData);
        } else {
            console.error("MMM-Best-Weather: Could not determine TOP1 city, no data to send.");
            this.sendSocketNotification("WEATHER_ERROR", "MMM-Best-Weather: Could not determine TOP1 city.");
            this.sendSocketNotification("WEATHER_DATA", { calculatedUpdateIntervalMs: calculatedUpdateIntervalMs });
        }
    },

    getWeatherCodeOverride: function(weatherCode, overrides) {
        if (overrides && overrides[weatherCode] !== undefined) {
            return overrides[weatherCode];
        }
        // Default for unknown weather codes
        return 0.5;
    },

    getWeatherIcon: function(weatherCode, isDay) {
        switch (weatherCode) {
            case 0:  // Clear sky
                return isDay ? "wi-day-sunny" : "wi-night-clear";
            case 1:  // Mainly clear
                return isDay ? "wi-day-sunny-overcast" : "wi-night-partly-cloudy";
            case 2:  // Partly cloudy
                return isDay ? "wi-day-cloudy" : "wi-night-cloudy";
            case 3:  // Overcast
                return isDay ? "wi-day-cloudy-high" : "wi-night-cloudy-high";
            case 45: // Fog
                return isDay ? "wi-day-fog" : "wi-night-fog";
            case 48: // Depositing rime fog
                return isDay ? "wi-freezing-fog" : "wi-freezing-fog-night";

            // --- Drizzle ---
            case 51: // Light drizzle
                return isDay ? "wi-drizzle" : "wi-drizzle-night";
            case 53: // Moderate drizzle
                return isDay ? "wi-heavy-drizzle" : "wi-heavy-drizzle-night";
            case 55: // Dense drizzle
                return isDay ? "wi-heavy-freezing-drizzle" : "wi-heavy-freezing-drizzle-night";
            case 56: // Freezing drizzle light
                return isDay ? "wi-freezing-drizzle" : "wi-freezing-drizzle-night";
            case 57: // Freezing drizzle dense
                return isDay ? "wi-heavy-freezing-drizzle" : "wi-heavy-freezing-drizzle-night";

            // --- Rain ---
            case 61: // Rain: Slight
                return isDay ? "wi-day-rain-mix" : "wi-night-rain-mix";
            case 63: // Rain: Moderate
                return isDay ? "wi-day-rain" : "wi-night-rain";
            case 65: // Rain: Heavy
                return isDay ? "wi-day-extreme-rain-showers" : "wi-night-extreme-rain-showers";
            case 66: // Freezing Rain: Light
                return isDay ? "wi-freezing-rain" : "wi-freezing-rain-night";
            case 67: // Freezing Rain: Heavy
                return isDay ? "wi-heavy-freezing-drizzle" : "wi-heavy-freezing-drizzle-night";

            // --- Snow ---
            case 71: // Snow: Slight
                return isDay ? "wi-day-snow" : "wi-night-snow";
            case 73: // Snow: Moderate
                return isDay ? "wi-day-snow" : "wi-night-snow";
            case 75: // Snow: Heavy
                return isDay ? "wi-day-snow-wind" : "wi-night-snow-wind";
            case 77: // Snow grains
                return isDay ? "wi-day-snow" : "wi-night-snow";

            // --- Showers ---
            case 80: // Rain showers: Slight
                return isDay ? "wi-day-showers" : "wi-night-showers";
            case 81: // Rain showers: Moderate
                return isDay ? "wi-day-storm-showers" : "wi-night-storm-showers";
            case 82: // Rain showers: Violent
                return isDay ? "wi-day-extreme-rain-showers" : "wi-night-extreme-rain-showers";

            case 85: // Snow showers: Slight
                return isDay ? "wi-day-snow" : "wi-night-snow";
            case 86: // Snow showers: Heavy
                return isDay ? "wi-day-snow-wind" : "wi-night-snow-wind";

            // --- Thunderstorms ---
            case 95: // Thunderstorm: Slight or moderate
                return isDay ? "wi-day-thunderstorm" : "wi-night-thunderstorm";
            case 96: // Thunderstorm with slight hail
                return isDay ? "wi-day-hail" : "wi-night-hail";
            case 99: // Thunderstorm with heavy hail
                return isDay ? "wi-day-hail" : "wi-night-hail";

            default:
                return "wi-na";
        }
    }
});
