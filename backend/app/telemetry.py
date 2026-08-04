import random
import time

import httpx

# Mission location matches the bathymetry map's default center (Cairns,
# Great Barrier Reef) so the "real" temperature/depth reflect an actual
# place.
MISSION_LAT = -16.9203
MISSION_LNG = 145.7781

_REAL_TEMP_CACHE_SECONDS = 600  # refetch at most every 10 minutes
_REAL_DEPTH_CACHE_SECONDS = 600  # bathymetry doesn't change; this is just
                                  # to avoid hammering a free public API on
                                  # every 1s telemetry tick


class TelemetrySimulator:
    """Simulates ROV sensor drift for salinity (no free, simple-REST
    source exists for real-time sea surface salinity — Copernicus
    Marine/NASA SMAP exist but require registered accounts and gridded
    NetCDF tooling, not a quick API call), while pulling REAL data for
    everything that actually has a free, no-key source:

    - Sea surface temperature: Open-Meteo's Marine Weather API
    - Seafloor depth: GEBCO bathymetry via Open Topo Data's free public
      API, queried at the mission's actual coordinates — this is real
      seafloor depth at a real location, not a random walk.
    """

    def __init__(self):
        self.depth = 42.6  # overwritten by the first successful real fetch
        self.temp = 17.2   # overwritten by the first successful real fetch
        self.salinity = 34.9
        self.heading = 86.0
        self.lat = MISSION_LAT
        self.lng = MISSION_LNG
        self._last_temp_fetch = 0.0
        self._last_depth_fetch = 0.0
        self._temp_ever_succeeded = False
        self._depth_ever_succeeded = False

    def _drift(self, value, step, low, high):
        value += random.uniform(-step, step)
        return max(low, min(high, value))

    async def _refresh_real_temperature(self):
        now = time.monotonic()
        if now - self._last_temp_fetch < _REAL_TEMP_CACHE_SECONDS:
            return  # still within the cache window, skip the API call

        try:
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.get(
                    "https://marine-api.open-meteo.com/v1/marine",
                    params={
                        "latitude": MISSION_LAT,
                        "longitude": MISSION_LNG,
                        "current": "sea_surface_temperature",
                    },
                )
                response.raise_for_status()
                data = response.json()
                real_temp = data.get("current", {}).get("sea_surface_temperature")
                if real_temp is not None:
                    self.temp = float(real_temp)
                    self._temp_ever_succeeded = True
        except Exception as exc:
            # Network hiccup or API down — keep drifting the last known
            # value instead of breaking the whole telemetry stream.
            print(f"[telemetry] Open-Meteo fetch failed, using simulated temp: {exc}")
        finally:
            self._last_temp_fetch = now

    async def _refresh_real_depth(self):
        now = time.monotonic()
        if now - self._last_depth_fetch < _REAL_DEPTH_CACHE_SECONDS:
            return  # still within the cache window, skip the API call

        try:
            async with httpx.AsyncClient(timeout=5) as client:
                response = await client.get(
                    "https://api.opentopodata.org/v1/gebco2020",
                    params={"locations": f"{self.lat},{self.lng}"},
                )
                response.raise_for_status()
                data = response.json()
                results = data.get("results", [])
                if results:
                    elevation = results[0].get("elevation")
                    # GEBCO elevation is relative to sea level: negative =
                    # below sea level (ocean depth), positive = land. A
                    # positive reading here means the current simulated
                    # position has drifted onto/near land in GEBCO's grid
                    # (possible near coastlines) — not a valid depth
                    # reading, so skip updating and let depth keep its
                    # last known real value instead of reporting negative
                    # depth or land elevation as if it were ocean depth.
                    if elevation is not None and elevation < 0:
                        self.depth = abs(float(elevation))
                        self._depth_ever_succeeded = True
        except Exception as exc:
            print(f"[telemetry] GEBCO bathymetry fetch failed, using simulated depth: {exc}")
        finally:
            self._last_depth_fetch = now

    async def tick(self):
        await self._refresh_real_temperature()
        await self._refresh_real_depth()

        # Small jitter on top of the real fetched values so neither looks
        # perfectly static between refreshes, without drifting away from
        # what was actually measured.
        self.depth = self._drift(self.depth, 0.15, self.depth - 1.5, self.depth + 1.5)
        self.temp = self._drift(self.temp, 0.03, self.temp - 0.3, self.temp + 0.3)
        self.salinity = self._drift(self.salinity, 0.03, 33.5, 36.0)
        self.heading = (self.heading + random.uniform(-1.5, 1.5)) % 360
        self.lat = self._drift(self.lat, 0.0004, -90, 90)
        self.lng = self._drift(self.lng, 0.0004, -180, 180)

        def _is_live(ever_succeeded, last_fetch, cache_seconds):
            # Reflects the outcome of the most recent fetch attempt, not
            # just "has it ever worked once" — so a currently-failing API
            # correctly shows as "simulated" again instead of getting
            # stuck on "live" forever.
            return ever_succeeded and (time.monotonic() - last_fetch) < cache_seconds

        return {
            "depth": round(self.depth, 1),
            "temp": round(self.temp, 1),
            "salinity": round(self.salinity, 1),
            "heading": round(self.heading),
            "lat": round(self.lat, 4),
            "lng": round(self.lng, 4),
            "temp_source": "live" if _is_live(
                self._temp_ever_succeeded, self._last_temp_fetch, _REAL_TEMP_CACHE_SECONDS
            ) else "simulated",
            "depth_source": "live" if _is_live(
                self._depth_ever_succeeded, self._last_depth_fetch, _REAL_DEPTH_CACHE_SECONDS
            ) else "simulated",
        }