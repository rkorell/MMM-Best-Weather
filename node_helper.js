/**
 * @file node_helper.js
 * @author Dr. Ralf Korell (2025)
 * @license MIT
 * @description Node helper for MMM-Best-Weather. Handles fetching weather data from Open-Meteo,
 *              calculating a "best weather" score for multiple cities, determining the TOP1 city,
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
            //console.log("MMM-Best-Weather: Attempting to read cities.json from:", citiesFilePath);
            const citiesData = await fs.readFile(citiesFilePath, "utf8");
            this.cities = JSON.parse(citiesData);
            //console.log(`MMM-Best-Weather: Successfully loaded ${this.cities.length} cities from cities.json.`);
        } catch (error) {
            console.error("MMM-Best-Weather: Error loading cities.json:", error);
            this.sendSocketNotification("WEATHER_ERROR", `MMM-Best-Weather: Failed to load cities.json: ${error.message}`);
        }
    },

    socketNotificationReceived: function(notification, payload) {
        //console.log("MMM-Best-Weather: Received notification:", notification);
        if (notification === "FETCH_WEATHER") {
            this.fetchWeatherData(payload);
        }
    },

    fetchWeatherData: async function(config) {
        //console.log("MMM-Best-Weather: fetchWeatherData called.");

        if (this.cities.length === 0) {
            console.error("MMM-Best-Weather: No cities loaded. Cannot fetch weather data.");
            this.sendSocketNotification("WEATHER_ERROR", "MMM-Best-Weather: No cities loaded for weather fetch.");
            return;
        }

        // 1. Prepare latitudes and longitudes for the Open-Meteo API
        const latitudes = this.cities.map(city => city.lat).join(",");
        const longitudes = this.cities.map(city => city.lon).join(",");

        // 2. Construct the Open-Meteo API URL
        const openMeteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${latitudes}&longitude=${longitudes}&current=temperature_2m,weathercode,precipitation,cloud_cover,relative_humidity_2m,wind_speed_10m`;
        //console.log("MMM-Best-Weather: Open-Meteo API URL:", openMeteoUrl);

        let openMeteoResponse;
        try {
            const response = await fetch(openMeteoUrl);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Open-Meteo API error: ${response.statusText} - ${errorText}`);
            }
            openMeteoResponse = await response.json();
            //console.log("MMM-Best-Weather: Open-Meteo API response received.");
            // console.log("MMM-Best-Weather: Open-Meteo API raw response:", JSON.stringify(openMeteoResponse, null, 2)); // Remains commented out
        } catch (error) {
            console.error("MMM-Best-Weather: Error fetching Open-Meteo data for all cities:", error);
            this.sendSocketNotification("WEATHER_ERROR", `MMM-Best-Weather: Open-Meteo multi-city fetch error: ${error.message}`);
            return;
        }

        // 3. Score calculation and determination of the TOP1 city
        let bestScore = -Infinity;
        let top1CityData = null;

        // The Open-Meteo response is an array of objects, one for each city.
        // We need to iterate through this array.
        if (Array.isArray(openMeteoResponse) && openMeteoResponse.length === this.cities.length) {
            const numCities = this.cities.length;

            // Configuration parameters for score calculation with default values
            const weathercodeImpact = config.weathercodeImpact !== undefined ? config.weathercodeImpact : 1;
            const humidityImpact = config.humidityImpact !== undefined ? config.humidityImpact : 0.05;
            const cloudImpact = config.cloudImpact !== undefined ? config.cloudImpact : 0.05;
            const precipitationImpact = config.precipitationImpact !== undefined ? config.precipitationImpact : 0.1;
            const windImpact = config.windImpact !== undefined ? config.windImpact : 0.05;

            //console.log(`MMM-Best-Weather: Score impacts - Weathercode: ${weathercodeImpact}, Humidity: ${humidityImpact}, Cloud: ${cloudImpact}, Precipitation: ${precipitationImpact}, Wind: ${windImpact}`);

            for (let i = 0; i < numCities; i++) {
                const city = this.cities[i];
                const cityWeatherResponse = openMeteoResponse[i]; // The weather object for the current city

                // Check if the weather response for this city is valid
                if (!cityWeatherResponse || !cityWeatherResponse.current || !cityWeatherResponse.current.temperature_2m) {
                    console.warn(`MMM-Best-Weather: Missing 'current' or 'temperature_2m' data for city index ${i} (${city.city}). Skipping this city.`);
                    continue; // Skip this city if its data is malformed
                }

                // Extract weather data for the current city from the Open-Meteo response
                const temp = cityWeatherResponse.current.temperature_2m;
                const weatherCode = cityWeatherResponse.current.weathercode;
                const precipitation = cityWeatherResponse.current.precipitation;
                const cloudCover = cityWeatherResponse.current.cloud_cover;
                const humidity = cityWeatherResponse.current.relative_humidity_2m;
                const windSpeed = cityWeatherResponse.current.wind_speed_10m;

                // Calculate weather bonus
                let weatherBonus = 0;
                if (weathercodeImpact !== 0) {
                    if (weatherCode === 0) { // Clear sky
                        weatherBonus = 1;
                    } else if (weatherCode >= 1 && weatherCode <= 3) { // Mainly clear, partly cloudy, overcast
                        weatherBonus = 0;
                    } else if ((weatherCode >= 45 && weatherCode <= 48) || (weatherCode >= 51 && weatherCode <= 61) || (weatherCode >= 63 && weatherCode <= 67)) { // Fog, Drizzle, Rain
                        weatherBonus = -1;
                    } else if (weatherCode >= 80 && weatherCode <= 82) { // Rain showers
                        weatherBonus = -2;
                    }
                    if (weathercodeImpact === 2) {
                        weatherBonus *= 2;
                    }
                }

                // Calculate score
                const score = temp + weatherBonus -
                              (humidityImpact * humidity) -
                              (cloudImpact * cloudCover) -
                              (precipitationImpact * precipitation) -
                              (windImpact * windSpeed);

                // console.log(`MMM-Best-Weather: City: ${city.city}, Temp: ${temp}, WC: ${weatherCode}, Precip: ${precipitation}, Cloud: ${cloudCover}, Humidity: ${humidity}, Wind: ${windSpeed}, WB: ${weatherBonus}, Score: ${score}`);

                if (score > bestScore) {
                    bestScore = score;
                    top1CityData = {
                        name: city.city,
                        temperature: temp,
                        weatherCode: weatherCode,
                        latitude: city.lat,
                        longitude: city.lon,
                        score: score,
                        // Additional fields for statistics file, as discussed
                        humidity: humidity,
                        cloudCover: cloudCover,
                        precipitation: precipitation,
                        windSpeed: windSpeed
                    };
                }
            }
            //console.log(`MMM-Best-Weather: TOP1 city determined: ${top1CityData ? top1CityData.name : 'None'}, Score: ${bestScore}`);
        } else {
            // More precise error message
            console.error("MMM-Best-Weather: Open-Meteo response is not an array or length mismatch with cities.json, or missing 'current' data for some cities.");
            this.sendSocketNotification("WEATHER_ERROR", "MMM-Best-Weather: Open-Meteo: Invalid response structure or missing data.");
            return;
        }

        // 4. Determine day or night for the TOP1 city
        let isDayForTop1 = true;
        if (top1CityData && top1CityData.latitude !== null && top1CityData.longitude !== null) {
            const now = new Date();
            const times = SunCalc.getTimes(now, top1CityData.latitude, top1CityData.longitude);
            isDayForTop1 = now > times.sunrise && now < times.sunset;
           // console.log(`MMM-Best-Weather: Day/Night for TOP1 city (${top1CityData.name}): isDay = ${isDayForTop1}`);
        } else {
            console.warn("MMM-Best-Weather: Could not determine day/night for TOP1 city (missing lat/lon). Defaulting to day.");
        }

        // 5. Calculate dynamic update interval
        const openmeteoMaxQueriesPerDay = config.openmeteoMaxQueriesPerDay || 5000; // Default to 5000 if not set
        const numCitiesToQuery = this.cities.length;

        let calculatedUpdateIntervalMs;
        let resultingUpdatesPerDay = 0; // Initialize for logging
        let resultingNumberOfQueriesPerDay = 0; // Initialize for logging

        if (numCitiesToQuery > 0) {
            // Calculate how many updates per day are allowed for this module
            let updatesPerDayCandidate = Math.floor(openmeteoMaxQueriesPerDay / numCitiesToQuery);

            // Round down updatesPerDay to the nearest multiple of 10 for a more conservative buffer
            updatesPerDayCandidate = Math.floor(updatesPerDayCandidate / 10) * 10;

            // Ensure updatesPerDay is at least 1 after rounding, to avoid division by zero
            if (updatesPerDayCandidate === 0) {
                updatesPerDayCandidate = 1;
            }
            resultingUpdatesPerDay = updatesPerDayCandidate; // Store for logging

            // Calculate interval in minutes, then convert to milliseconds
            const totalMinutesInDay = 24 * 60;
            const intervalInMinutes = totalMinutesInDay / resultingUpdatesPerDay;
            calculatedUpdateIntervalMs = intervalInMinutes * 60 * 1000;

            resultingNumberOfQueriesPerDay = resultingUpdatesPerDay * numCitiesToQuery; // Store for logging

        } else {
            // No cities to query, use MAX_UPDATE_INTERVAL to prevent frequent checks
            console.warn("MMM-Best-Weather: No cities configured. Using MAX_UPDATE_INTERVAL for update scheduling.");
            calculatedUpdateIntervalMs = MAX_UPDATE_INTERVAL;
            // For logging, set these to 0 as no queries are being made
            resultingUpdatesPerDay = 0;
            resultingNumberOfQueriesPerDay = 0;
        }

        // Apply min/max bounds to the calculated interval
        calculatedUpdateIntervalMs = Math.max(MIN_UPDATE_INTERVAL, calculatedUpdateIntervalMs);
        calculatedUpdateIntervalMs = Math.min(MAX_UPDATE_INTERVAL, calculatedUpdateIntervalMs);

       // console.log(`MMM-Best-Weather: API Stats: Max Queries: ${openmeteoMaxQueriesPerDay}, City Count: ${numCitiesToQuery} - Update Interval: ${calculatedUpdateIntervalMs / (60 * 1000)} minutes, Resulting Queries: ${resultingNumberOfQueriesPerDay}`);

        // NEW: 6. Write statistics to file if configured
        if (config.statisticsFileName && top1CityData) {
            const statsFilePath = this.path + "/" + config.statisticsFileName;
            const now = new Date();
            // Format timestamp as DD.MM.YYYY HH:MM
            const timestamp = `${now.getDate().toString().padStart(2, '0')}.${(now.getMonth() + 1).toString().padStart(2, '0')}.${now.getFullYear()} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
            
            // Construct CSV line with semicolon delimiter
            const csvLine = `${timestamp};${top1CityData.name};${top1CityData.weatherCode};${top1CityData.temperature};${top1CityData.humidity};${top1CityData.cloudCover};${top1CityData.precipitation};${top1CityData.windSpeed};${top1CityData.score.toFixed(3)}\n`;

            try {
                // Check if file exists to write header (fs.constants.F_OK checks for file existence)
                const fileExists = await fs.access(statsFilePath, fs.constants.F_OK)
                    .then(() => true)
                    .catch(() => false); // If access fails, file does not exist

                if (!fileExists) {
                    const header = "Timestamp;City;WeatherCode;Temperature;Humidity;CloudCover;Precipitation;WindSpeed;Score\n";
                    await fs.writeFile(statsFilePath, header, { encoding: 'utf8' });
                   // console.log(`MMM-Best-Weather: Created new statistics file with header: ${statsFilePath}`);
                }
                await fs.appendFile(statsFilePath, csvLine, { encoding: 'utf8' });
               // console.log(`MMM-Best-Weather: Appended statistics for ${top1CityData.name} to ${statsFilePath}`);
            } catch (error) {
                console.error(`MMM-Best-Weather: Error writing statistics to file ${statsFilePath}:`, error);
            }
        }

        // 7. Send the TOP1 city data and the calculated update interval to the main module
        if (top1CityData) {
            const weatherData = {
                cityName: top1CityData.name,
                temperature: top1CityData.temperature,
                weatherCode: top1CityData.weatherCode,
                isDay: isDayForTop1,
                weatherIconClass: this.getWeatherIcon(top1CityData.weatherCode, isDayForTop1),
                calculatedUpdateIntervalMs: calculatedUpdateIntervalMs // Send calculated interval
            };
           // console.log("MMM-Best-Weather: Sending WEATHER_DATA notification with:", weatherData);
            this.sendSocketNotification("WEATHER_DATA", weatherData);
        } else {
            console.error("MMM-Best-Weather: Could not determine TOP1 city, no data to send.");
            this.sendSocketNotification("WEATHER_ERROR", "MMM-Best-Weather: Could not determine TOP1 city.");
            // Even if no TOP1 city, still send calculated interval for next attempt
            this.sendSocketNotification("WEATHER_DATA", { calculatedUpdateIntervalMs: calculatedUpdateIntervalMs });
        }
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