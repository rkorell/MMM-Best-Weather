/**
 * @file MMM-Best-Weather.js
 * @author Dr. Ralf Korell (2025)
 * @license MIT
 * @description A MagicMirror module to display the "best weather" city out of a configured list,
 *              based on a customizable scoring system derived from Open-Meteo data.
 *              Includes temperature-sensitive coloring and a history of the last TOP1 cities.
 *
 * @changelog
 *   2025-09-28 15:00 UTC: Initial creation/major refactoring based on MMM-My-Actual-Weather.
 *   2025-09-28 15:05 UTC: Implemented dynamic update interval calculation based on API limits.
 *                        Added 'openmeteoMaxQueriesPerDay' and 'statisticsFileName' config parameters.
 *                        Translated all comments to English.
 *   2026-02-08 13:30 UTC: Replaced old linear score config params with HCI-adapted parameters
 *                        (tOpt, sigma, wcOverrides). Added optional score display (showScore).
 */

Module.register("MMM-Best-Weather", {
    // Helper to convert any CSS color string (named, hex, rgb()) to RGB object
    // This function leverages the browser's ability to compute styles.
    cssColorToRgb: function(colorString) {
        // Create a temporary element
        const tempDiv = document.createElement('div');
        // Make it invisible and small, but still part of the layout for getComputedStyle
        tempDiv.style.cssText = `position: absolute; visibility: hidden; width: 1px; height: 1px; color: ${colorString};`;
        document.body.appendChild(tempDiv);
        const computedColor = window.getComputedStyle(tempDiv).color;
        document.body.removeChild(tempDiv);

        // --- ADDED LOGGING FOR DEBUGGING (from previous step) ---
        Log.log(`MMM-Best-Weather: Resolving color "${colorString}" -> Computed: "${computedColor}"`);
        // --- END ADDED LOGGING ---

        const match = computedColor.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        if (match) {
            return {
                r: parseInt(match[1]),
                g: parseInt(match[2]),
                b: parseInt(match[3])
            };
        }
        // Fallback for hex if it was passed directly and not converted by browser, or other formats
        // This is less likely to be hit if colorString is a valid CSS color name or hex.
        if (colorString.startsWith("#") && (colorString.length === 7 || colorString.length === 4)) {
            const bigint = parseInt(colorString.slice(1), 16);
            return {
                r: (bigint >> 16) & 255,
                g: (bigint >> 8) & 255,
                b: bigint & 255
            };
        }
        Log.warn(`MMM-Best-Weather: Failed to resolve color "${colorString}" to RGB. Computed: "${computedColor}". Defaulting to white.`);
        return { r: 255, g: 255, b: 255 }; // Default to white if resolution fails
    },

    // Default configurations for the module
    defaults: {
        // Removed: updateInterval - now dynamically calculated by node_helper
        animationSpeed: 1000, // Animation speed in milliseconds
        lang: config.language, // Language from MagicMirror configuration
        decimalPlacesTemp: 1, // Number of decimal places for temperature

        // HCI-adapted score parameters
        tOpt: 22, // Optimal apparent temperature (°C) for Gaussian thermal comfort curve
        sigma: 10, // Gaussian width — how quickly comfort drops away from tOpt
        wcOverrides: { // Weather code override multipliers (0.0 = worst, 1.0 = no penalty)
            0: 1.0, 1: 1.0, 2: 1.0,       // Clear / mainly clear / partly cloudy
            3: 0.9,                          // Overcast
            45: 0.7, 48: 0.7,               // Fog / depositing rime fog
            51: 0.7, 53: 0.7, 55: 0.7,      // Drizzle (light / moderate / dense)
            56: 0.5, 57: 0.5,               // Freezing drizzle
            61: 0.6, 63: 0.4, 65: 0.3,      // Rain (slight / moderate / heavy)
            66: 0.3, 67: 0.3,               // Freezing rain
            71: 0.4, 73: 0.4, 75: 0.3, 77: 0.4, // Snow
            80: 0.5, 81: 0.3, 82: 0.3,      // Rain showers
            85: 0.4, 86: 0.3,               // Snow showers
            95: 0.2, 96: 0.1, 99: 0.1       // Thunderstorms
        },
        showScore: false, // If true, show HCI score next to city name, e.g. "Freiburg (29)"
        showTop1History: false, // boolean, whether to display the history of TOP1 cities

        // New config parameters for dynamic update interval
        openmeteoMaxQueriesPerDay: 5000, // Maximum Open-Meteo queries allowed per day for this module

        // Statistics file (new HCI format, old CSV remains as archive)
        statisticsFileName: "BestWeatherStatisticsHCI.csv", // File name for statistics

        // New color parameters
        cityColor: "white", // Color for the city name
        historyColor: "grey", // Color for the history of TOP1 cities
        temperatureColor: "white", // Default color for temperature (if tempSensitive is false)
        tempSensitive: true, // If true, temperature color changes based on value
        // Define temperature points and their corresponding colors (named or hex)
        // The module will interpolate colors between these points.
        tempColorGradient: [
            { temp: -20, color: "#b05899" },
            { temp: -14, color: "#6a4490" },
            { temp: -10, color: "#544691" },
            { temp: -5, color: "#484894" },
            { temp: -1, color: "#547bbb" },
            { temp: 4, color: "#70bbe8" },
            { temp: 8, color: "#c2ce2c" },
            { temp: 12, color: "#ecc82d" },
            { temp: 16, color: "#eebf2e" },
            { temp: 20, color: "#eec12c" },
            { temp: 24, color: "#e2a657" },
            { temp: 27, color: "#db8f32" },
            { temp: 30, color: "#bb5a20" },
            { temp: 32, color: "#c04117" }
        ]
    },

    // Module initialization
    start: function() {
        this.weatherData = null; // Stores the fetched weather data
        this.loaded = false; // Flag if data has been loaded
        this.top1History = []; // Initializes the buffer for the TOP1 history
        this.currentUpdateTimer = null; // Stores the timer for updates
        this.getWeatherData(); // Starts the first data fetch
        // scheduleUpdate will be called after first data fetch with calculated interval
        Log.info("Starting module: " + this.name);
    },

    // CSS files to be loaded
    getStyles: function() {
        return ["MMM-Best-Weather.css", "weather-icons.css"];
    },

    // Translations for the module
    getTranslations: function() {
        return {
            en: "translations/en.json",
            de: "translations/de.json"
        };
    },

    // Helper function to get the interpolated temperature color
    getTemperatureColor: function(temp) {
        if (!this.config.tempSensitive) {
            return this.config.temperatureColor; // Use fixed color if not sensitive
        }

        // Resolve named colors and sort gradient points by temperature
        const gradientPoints = this.config.tempColorGradient
            // Store original color name as 'colorName' and resolved RGB as 'rgb'
            .map(point => ({ temp: point.temp, colorName: point.color, rgb: this.cssColorToRgb(point.color) }))
            .sort((a, b) => a.temp - b.temp); // Ensure points are sorted by temperature

        Log.log(`MMM-Best-Weather: Calculating color for temp ${temp}°C`);

        if (gradientPoints.length === 0) {
            Log.warn("MMM-Best-Weather: tempColorGradient is empty. Defaulting to white.");
            return "rgb(255, 255, 255)"; // Fallback if no gradient points are defined
        }
        if (gradientPoints.length === 1) {
            Log.log(`MMM-Best-Weather: Only one gradient point. Using color: rgb(${gradientPoints[0].rgb.r}, ${gradientPoints[0].rgb.g}, ${gradientPoints[0].rgb.b})`);
            return `rgb(${gradientPoints[0].rgb.r}, ${gradientPoints[0].rgb.g}, ${gradientPoints[0].rgb.b})`; // Only one point, use its color
        }

        // Find the segment for the current temperature
        let lowerPoint = null;
        let upperPoint = null;

        for (let i = 0; i < gradientPoints.length - 1; i++) {
            if (temp >= gradientPoints[i].temp && temp <= gradientPoints[i + 1].temp) {
                lowerPoint = gradientPoints[i];
                upperPoint = gradientPoints[i + 1];
                break;
            }
        }

        // Handle temperatures outside the defined range
        if (temp < gradientPoints[0].temp) {
            Log.log(`MMM-Best-Weather: Temp ${temp}°C below lowest point ${gradientPoints[0].temp}°C. Using color of lowest point (${gradientPoints[0].colorName}).`);
            return `rgb(${gradientPoints[0].rgb.r}, ${gradientPoints[0].rgb.g}, ${gradientPoints[0].rgb.b})`;
        }
        if (temp > gradientPoints[gradientPoints.length - 1].temp) {
            Log.log(`MMM-Best-Weather: Temp ${temp}°C above highest point ${gradientPoints[gradientPoints.length - 1].temp}°C. Using color of highest point (${gradientPoints[gradientPoints.length - 1].colorName}).`);
            return `rgb(${gradientPoints[gradientPoints.length - 1].rgb.r}, ${gradientPoints[gradientPoints.length - 1].rgb.g}, ${gradientPoints[gradientPoints.length - 1].rgb.b})`;
        }

        // If for some reason lowerPoint or upperPoint are still null (shouldn't happen with the above checks)
        if (!lowerPoint || !upperPoint) {
            Log.error(`MMM-Best-Weather: Logic error in getTemperatureColor for temp ${temp}°C. Falling back to white.`);
            return "rgb(255, 255, 255)";
        }

        // Calculate interpolation factor (0 to 1)
        const factor = (temp - lowerPoint.temp) / (upperPoint.temp - lowerPoint.temp);

        // Interpolate RGB components
        const r = Math.round(lowerPoint.rgb.r + factor * (upperPoint.rgb.r - lowerPoint.rgb.r));
        const g = Math.round(lowerPoint.rgb.g + factor * (upperPoint.rgb.g - lowerPoint.rgb.g));
        const b = Math.round(lowerPoint.rgb.b + factor * (upperPoint.rgb.b - lowerPoint.rgb.b));

        const finalColor = `rgb(${r}, ${g}, ${b})`;
        // Log the colorName property, which now holds the original string
        Log.log(`MMM-Best-Weather: Temp ${temp}°C, Segment: ${lowerPoint.temp}°C (${lowerPoint.colorName}) to ${upperPoint.temp}°C (${upperPoint.colorName}), Factor: ${factor.toFixed(4)}, Final Color: ${finalColor}`);
        return finalColor;
    },

    // Creates the DOM content of the module
    getDom: function() {
        var wrapper = document.createElement("div");
        wrapper.className = "MMM-Best-Weather";

        if (!this.loaded) {
            wrapper.innerHTML = this.translate("LOADING");
            wrapper.className += " dimmed light small";
            return wrapper;
        }

        if (!this.weatherData) {
            wrapper.innerHTML = this.translate("NO_WEATHER_DATA");
            wrapper.className += " dimmed light small";
            return wrapper;
        }

        // --- Current Weather Section (mimics default module structure) ---
        var currentWeatherWrapper = document.createElement("div");
        currentWeatherWrapper.className = "current-weather-wrapper";

        // Weather Details (Icon and Temperature)
        var weatherDetails = document.createElement("div");
        weatherDetails.className = "weather-details";

        // Weather Icon
        var iconSpan = document.createElement("span");
        iconSpan.className = "icon";
        var weatherIcon = document.createElement("span");
        weatherIcon.className = "wi " + this.weatherData.weatherIconClass;
        iconSpan.appendChild(weatherIcon);
        weatherDetails.appendChild(iconSpan);

        // Temperature
        var temperature = document.createElement("span");
        temperature.className = "temperature";
        temperature.innerHTML = this.weatherData.temperature.toFixed(this.config.decimalPlacesTemp) + "&deg;";
        temperature.style.color = this.getTemperatureColor(this.weatherData.temperature);
        weatherDetails.appendChild(temperature);

        currentWeatherWrapper.appendChild(weatherDetails);

        // --- ADAPTATION OF WIND INFORMATION TO CITY NAME ---
        var cityNameInfo = document.createElement("div");
        cityNameInfo.className = "city-name-info";
        var cityNameSpan = document.createElement("span");
        cityNameSpan.className = "city-name";
        cityNameSpan.innerHTML = this.config.showScore && this.weatherData.score !== undefined
            ? this.weatherData.cityName + " (" + Math.round(this.weatherData.score) + ")"
            : this.weatherData.cityName;
        cityNameInfo.appendChild(cityNameSpan);
        cityNameInfo.style.color = this.config.cityColor; // Apply color for city name
        currentWeatherWrapper.appendChild(cityNameInfo);
        // --- END OF ADAPTATION OF WIND INFORMATION TO CITY NAME ---

        wrapper.appendChild(currentWeatherWrapper);

        // --- ADAPTATION OF PRECIPITATION INFORMATION TO TOP1 HISTORY ---
        var top1HistoryInfo = document.createElement("div");
        top1HistoryInfo.className = "top1-history-info";

        if (this.config.showTop1History && this.top1History.length > 0) {
            this.top1History.forEach((city, index) => {
                const historyEntry = document.createElement("div");
                historyEntry.className = "history-entry" + (index === 0 ? " current-top1" : "");
                historyEntry.innerHTML = city;
                historyEntry.style.color = this.config.historyColor; // Apply color for history
                top1HistoryInfo.appendChild(historyEntry);
            });
        } else if (this.config.showTop1History && this.top1History.length === 0) {
            const noHistory = document.createElement("div");
            noHistory.className = "no-history";
            noHistory.innerHTML = this.translate("NO_HISTORY_DATA");
            noHistory.style.color = this.config.historyColor; // Apply color for history
            top1HistoryInfo.appendChild(noHistory);
        }

        wrapper.appendChild(top1HistoryInfo);
        // --- END OF ADAPTATION OF PRECIPITATION INFORMATION TO TOP1 HISTORY ---

        return wrapper;
    },

    // Schedules the next update
    scheduleUpdate: function(delay) {
        var self = this;
        // Clear any existing timer to prevent multiple updates
        if (this.currentUpdateTimer) {
            clearTimeout(this.currentUpdateTimer);
        }
        // Schedule the next update
        this.currentUpdateTimer = setTimeout(function() {
            self.getWeatherData();
        }, delay);
        Log.log(`MMM-Best-Weather: Next update scheduled in ${delay / 1000} seconds.`);
    },

    // Requests weather data from the node_helper
    getWeatherData: function() {
        // Send the full config to the node_helper, including new impact parameters and API limit
        this.sendSocketNotification("FETCH_WEATHER", this.config);
    },

    // Receives notifications from the node_helper
    socketNotificationReceived: function(notification, payload) {
        if (notification === "WEATHER_DATA") {
            // Update weatherData
            this.weatherData = payload;

            // Add the current TOP1 city to the history
            if (this.weatherData && this.weatherData.cityName) {
                // Only add if it's a new city or history is empty
                if (this.top1History.length === 0 || this.top1History[0] !== this.weatherData.cityName) {
                    this.top1History.unshift(this.weatherData.cityName); // Add to the beginning
                    if (this.top1History.length > 2) {
                        this.top1History.pop(); // Remove the oldest city if more than 2 are present
                    }
                }
            }

            this.loaded = true;
            this.updateDom(this.config.animationSpeed);

            // Reschedule update with the interval calculated by the node_helper
            if (payload.calculatedUpdateIntervalMs) {
                this.scheduleUpdate(payload.calculatedUpdateIntervalMs);
            } else {
                Log.warn("MMM-Best-Weather: Node_helper did not provide an update interval. Scheduling with default (30 minutes).");
                this.scheduleUpdate(30 * 60 * 1000); // Fallback to 30 minutes
            }

        } else if (notification === "WEATHER_ERROR") {
            Log.error(this.name + ": " + payload);
            this.loaded = true;
            this.weatherData = null; // Set data to null to display error message
            this.updateDom(this.config.animationSpeed);
            // On error, try again after a fixed interval (e.g., 5 minutes) to avoid hammering the API
            this.scheduleUpdate(5 * 60 * 1000);
        }
    }
});