import requests
import json

# Datei mit Städtenamen und Koordinaten einlesen
with open("cities.json", "r", encoding="utf-8") as f:
    cities = json.load(f)

# Längen- und Breitengrade für die URL zusammenbauen
latitudes = ",".join([str(city["lat"]) for city in cities])
longitudes = ",".join([str(city["lon"]) for city in cities])

# Open-Meteo URL bauen
url = f"https://api.open-meteo.com/v1/forecast?latitude={latitudes}&longitude={longitudes}&&current=temperature_2m,weathercode"

print(f"Fetching: {url}\n")

# Request senden
response = requests.get(url)
data = response.json()

# Ergebnisse ausgeben
for city, result in zip(cities, data):
    current = result.get("current", {})
    temp = current.get("temperature_2m", "n/a")
    code = current.get("weathercode", "n/a")
    print(f"{city['city']}: {temp}°C (weather code {code})")
