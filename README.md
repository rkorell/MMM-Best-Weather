# MMM-Best-Weather

A [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) module that displays the German city with the best current weather, selected from a configurable list of 45 cities using a scoring system based on [Open-Meteo](https://open-meteo.com/) data.

![Screenshot](img/MMM-BestWeather.png)

## Features

- Scores 45 German cities based on temperature, weather conditions, humidity, cloud cover, precipitation and wind
- Configurable scoring weights for each factor
- Temperature-sensitive color gradient (matching personal weather station display)
- Day/night weather icons (using suncalc)
- Optional TOP1 city history display
- Dynamic update interval based on Open-Meteo API limits
- Statistics logging to CSV (for analysis)
- Multi-language support (English, German)

## Score Formula

```
score = temperature + (weatherBonus × weathercodeImpact)
        - (humidity × humidityImpact)
        - (cloudCover × cloudImpact)
        - (precipitation × precipitationImpact)
        - (windSpeed × windImpact)
```

**Weather Bonus:** Clear sky → +1, Cloudy → 0, Fog/Rain → -1, Showers → -2

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/rkorell/MMM-Best-Weather.git
cd MMM-Best-Weather
npm install
```

## Configuration

Add to your `config/config.js`:

```js
{
    module: "MMM-Best-Weather",
    position: "bottom_left",
    config: {
        weathercodeImpact: 1,       // 0 = off, 1 = normal, 2 = strong
        humidityImpact: 0.05,
        cloudImpact: 0.05,
        precipitationImpact: 0.1,
        windImpact: 0.05,
        showTop1History: true,
        decimalPlacesTemp: 1,
        tempSensitive: true,
        cityColor: "white",
        historyColor: "grey",
        openmeteoMaxQueriesPerDay: 5000,
        tempColorGradient: [
            { temp: -20, color: "#b05899" },
            { temp: -14, color: "#6a4490" },
            { temp: -10, color: "#544691" },
            { temp:  -5, color: "#484894" },
            { temp:  -1, color: "#547bbb" },
            { temp:   4, color: "#70bbe8" },
            { temp:   8, color: "#c2ce2c" },
            { temp:  12, color: "#ecc82d" },
            { temp:  16, color: "#eebf2e" },
            { temp:  20, color: "#eec12c" },
            { temp:  24, color: "#e2a657" },
            { temp:  27, color: "#db8f32" },
            { temp:  30, color: "#bb5a20" },
            { temp:  32, color: "#c04117" }
        ]
    }
}
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `weathercodeImpact` | int | `1` | Weather condition impact on score (0, 1 or 2) |
| `humidityImpact` | float | `0.05` | Humidity weight in score formula |
| `cloudImpact` | float | `0.05` | Cloud cover weight in score formula |
| `precipitationImpact` | float | `0.1` | Precipitation weight in score formula |
| `windImpact` | float | `0.05` | Wind speed weight in score formula |
| `showTop1History` | bool | `false` | Show last 2 TOP1 cities |
| `decimalPlacesTemp` | int | `1` | Decimal places for temperature display |
| `tempSensitive` | bool | `true` | Enable temperature-based color gradient |
| `tempColorGradient` | array | see above | Temperature-to-color mapping for gradient |
| `cityColor` | string | `"white"` | Color of the city name |
| `historyColor` | string | `"grey"` | Color of the TOP1 history |
| `temperatureColor` | string | `"white"` | Fixed temperature color (when `tempSensitive: false`) |
| `openmeteoMaxQueriesPerDay` | int | `5000` | API query budget per day |
| `statisticsFileName` | string | `"BestWeatherStatistics.csv"` | Statistics output file |
| `animationSpeed` | int | `1000` | DOM update animation (ms) |

## Cities

The module evaluates 45 German cities defined in `cities.json`. Each entry contains city name, state, latitude and longitude. The list can be customized.

## API

Uses the free [Open-Meteo API](https://open-meteo.com/) — no API key required. The module dynamically calculates its update interval to stay within the configured daily query limit.

## Dependencies

- [node-fetch](https://www.npmjs.com/package/node-fetch) — HTTP requests
- [suncalc](https://www.npmjs.com/package/suncalc) — Day/night icon determination

## License

MIT — Dr. Ralf Korell
