import random


import time

import requests

# Mission location matches the bathymetry map's default center (Cairns,
# Great Barrier Reef) so the "real" temperature reflects an actual place.
MISSION_LAT = -16.9203
MISSION_LNG = 145.7781

_REAL_TEMP_CACHE_SECONDS = 600  # refetch at most every 10 minutes


class TelemetrySimulator:
    """Simulates realistic ROV sensor drift for depth/salinity/heading (no
    free source exists for vehicle-specific readings like these), while
    pulling REAL live sea surface temperature from Open-Meteo's free Marine
    Weather API for the mission's actual coordinates."""

    def __init__(self):
        self.depth = 42.6
        self.temp = 17.2  # overwritten by the first successful real fetch
        self.salinity = 34.9
        self.heading = 86.0
        self.lat = MISSION_LAT
        self.lng = MISSION_LNG
        self._last_temp_fetch = 0.0

    def _drift(self, value, step, low, high):
        value += random.uniform(-step, step)
        return max(low, min(high, value))

    def _refresh_real_temperature(self):
        now = time.monotonic()
        if now - self._last_temp_fetch < _REAL_TEMP_CACHE_SECONDS:
            return  # still within the cache window, skip the API call

        try:
            response = requests.get(
                "https://marine-api.open-meteo.com/v1/marine",
                params={
                    "latitude": MISSION_LAT,
                    "longitude": MISSION_LNG,
                    "current": "sea_surface_temperature",
                },
                timeout=5,
            )
            response.raise_for_status()
            data = response.json()
            real_temp = data.get("current", {}).get("sea_surface_temperature")
            if real_temp is not None:
                self.temp = float(real_temp)
        except Exception as exc:
            # Network hiccup or API down — keep drifting the last known
            # value instead of breaking the whole telemetry stream.
            print(f"[telemetry] Open-Meteo fetch failed, using simulated temp: {exc}")
        finally:
            self._last_temp_fetch = now

    def tick(self):
        self._refresh_real_temperature()

        self.depth = self._drift(self.depth, 0.15, 35.0, 55.0)
        # Small jitter on top of the real fetched value so it doesn't look
        # perfectly static between refreshes, without drifting away from it.
        self.temp = self._drift(self.temp, 0.03, self.temp - 0.3, self.temp + 0.3)
        self.salinity = self._drift(self.salinity, 0.03, 33.5, 36.0)
        self.heading = (self.heading + random.uniform(-1.5, 1.5)) % 360
        self.lat = self._drift(self.lat, 0.0004, -90, 90)
        self.lng = self._drift(self.lng, 0.0004, -180, 180)

        return {
            "depth": round(self.depth, 1),
            "temp": round(self.temp, 1),
            "salinity": round(self.salinity, 1),
            "heading": round(self.heading),
            "lat": round(self.lat, 4),
            "lng": round(self.lng, 4),
            "temp_source": "live" if self._last_temp_fetch > 0 else "simulated",
        }