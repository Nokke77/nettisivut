#!/usr/bin/env python3
"""Build and send a privacy-safe SkyScope snapshot using only the standard library."""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


DEFAULT_AIRCRAFT_PATH = "/run/readsb/aircraft.json"
DEFAULT_DATABASE_PATH = "/home/noel/skyscope/skyscope.db"
PASS_GAP = timedelta(minutes=15)
MAX_RECENT_PASSES = 100
LOGGER = logging.getLogger("skyscope-exporter")


class ConfigurationError(ValueError):
    """Raised when required exporter configuration is missing or invalid."""


@dataclass(frozen=True)
class Observation:
    captured_at: datetime
    icao: str
    callsign: str | None
    latitude: float | None
    longitude: float | None
    distance_km: float | None


def parse_timestamp(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        raise ValueError("timestamp is missing")
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def optional_number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def optional_integer(value: Any) -> int | None:
    number = optional_number(value)
    if number is None or number < 0:
        return None
    return int(number)


def haversine_km(latitude_a: float, longitude_a: float, latitude_b: float, longitude_b: float) -> float:
    radius_km = 6371.0088
    lat_a = math.radians(latitude_a)
    lat_b = math.radians(latitude_b)
    delta_lat = lat_b - lat_a
    delta_lon = math.radians(longitude_b - longitude_a)
    chord = math.sin(delta_lat / 2) ** 2 + math.cos(lat_a) * math.cos(lat_b) * math.sin(delta_lon / 2) ** 2
    return radius_km * 2 * math.atan2(math.sqrt(chord), math.sqrt(1 - chord))


def normalize_icao(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    if not normalized or len(normalized) > 16:
        return None
    return normalized


def normalize_callsign(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().upper()
    return normalized[:16] or None


def valid_position(latitude: float | None, longitude: float | None) -> bool:
    return (
        latitude is not None
        and longitude is not None
        and -90 <= latitude <= 90
        and -180 <= longitude <= 180
    )


def build_current_aircraft(
    readsb_payload: Mapping[str, Any],
    receiver_latitude: float,
    receiver_longitude: float,
    fallback_now: datetime | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    fallback_now = fallback_now or datetime.now(timezone.utc)
    try:
        captured_at = parse_timestamp(readsb_payload.get("now", fallback_now.timestamp()))
    except (TypeError, ValueError, OverflowError):
        captured_at = fallback_now

    raw_aircraft = readsb_payload.get("aircraft")
    if not isinstance(raw_aircraft, list):
        raw_aircraft = []

    aircraft: list[dict[str, Any]] = []
    for raw in raw_aircraft:
        if not isinstance(raw, Mapping):
            continue
        icao = normalize_icao(raw.get("hex"))
        if not icao:
            continue
        latitude = optional_number(raw.get("lat"))
        longitude = optional_number(raw.get("lon"))
        if not valid_position(latitude, longitude):
            latitude = None
            longitude = None
        distance = (
            haversine_km(receiver_latitude, receiver_longitude, latitude, longitude)
            if latitude is not None and longitude is not None
            else None
        )
        seen_seconds = max(0.0, optional_number(raw.get("seen")) or 0.0)
        altitude = optional_number(raw.get("alt_baro"))
        if altitude is None:
            altitude = optional_number(raw.get("alt_geom"))
        aircraft.append({
            "icao": icao,
            "callsign": normalize_callsign(raw.get("flight")),
            "latitude": latitude,
            "longitude": longitude,
            "altitude_ft": altitude,
            "speed_knots": optional_number(raw.get("gs")),
            "track_deg": optional_number(raw.get("track")),
            "signal_db": optional_number(raw.get("rssi")),
            "distance_km": round(distance, 3) if distance is not None else None,
            "messages": optional_integer(raw.get("messages")),
            "seen_at": isoformat(captured_at - timedelta(seconds=seen_seconds)),
        })

    aircraft.sort(key=lambda item: (
        item["distance_km"] is None,
        item["distance_km"] if item["distance_km"] is not None else math.inf,
        item["icao"],
    ))
    return isoformat(captured_at), aircraft


def observation_from_row(
    row: Mapping[str, Any], receiver_latitude: float, receiver_longitude: float
) -> Observation | None:
    icao = normalize_icao(row["icao"])
    if not icao:
        return None
    try:
        captured_at = parse_timestamp(row["captured_at"])
    except (TypeError, ValueError, OverflowError):
        return None
    latitude = optional_number(row["latitude"])
    longitude = optional_number(row["longitude"])
    if not valid_position(latitude, longitude):
        latitude = None
        longitude = None
    distance = (
        haversine_km(receiver_latitude, receiver_longitude, latitude, longitude)
        if latitude is not None and longitude is not None
        else None
    )
    return Observation(
        captured_at=captured_at,
        icao=icao,
        callsign=normalize_callsign(row["callsign"]),
        latitude=latitude,
        longitude=longitude,
        distance_km=distance,
    )


def group_passes(
    rows: Iterable[Mapping[str, Any]],
    receiver_latitude: float,
    receiver_longitude: float,
    gap: timedelta = PASS_GAP,
) -> list[dict[str, Any]]:
    observations = [
        observation
        for row in rows
        if (observation := observation_from_row(row, receiver_latitude, receiver_longitude)) is not None
    ]
    observations.sort(key=lambda observation: (observation.icao, observation.captured_at))

    groups: list[list[Observation]] = []
    current: list[Observation] = []
    for observation in observations:
        if current and (
            observation.icao != current[-1].icao
            or observation.captured_at - current[-1].captured_at > gap
        ):
            groups.append(current)
            current = []
        current.append(observation)
    if current:
        groups.append(current)

    passes: list[dict[str, Any]] = []
    for group in groups:
        first = group[0]
        last = group[-1]
        closest = min(
            (observation for observation in group if observation.distance_km is not None),
            key=lambda observation: observation.distance_km,
            default=None,
        )
        callsign = next((observation.callsign for observation in reversed(group) if observation.callsign), None)
        stable_source = f"{first.icao}|{isoformat(first.captured_at)}".encode("utf-8")
        passes.append({
            "id": hashlib.sha256(stable_source).hexdigest(),
            "icao": first.icao,
            "callsign": callsign,
            "first_seen": isoformat(first.captured_at),
            "last_seen": isoformat(last.captured_at),
            "closest_distance_km": round(closest.distance_km, 3) if closest else None,
            "closest_at": isoformat(closest.captured_at) if closest else None,
        })
    passes.sort(key=lambda item: item["last_seen"], reverse=True)
    return passes


def read_aircraft_json(path: str) -> Mapping[str, Any]:
    with Path(path).open("r", encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, Mapping):
        raise ValueError("aircraft.json root must be an object")
    return payload


def read_observations(path: str, since: datetime) -> list[sqlite3.Row]:
    database_path = Path(path)
    if not database_path.is_file():
        raise FileNotFoundError(f"SQLite database not found: {database_path}")
    connection = sqlite3.connect(f"file:{database_path}?mode=ro", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    try:
        return connection.execute(
            """
            SELECT captured_at, icao, callsign, latitude, longitude
            FROM observations
            WHERE julianday(captured_at) >= julianday(?)
            ORDER BY icao, captured_at
            """,
            (isoformat(since),),
        ).fetchall()
    finally:
        connection.close()


def build_stats(
    passes: list[dict[str, Any]], observations: Iterable[Mapping[str, Any]],
    receiver_latitude: float, receiver_longitude: float, local_date: str, local_timezone: ZoneInfo
) -> dict[str, Any]:
    todays_observations = []
    for row in observations:
        observation = observation_from_row(row, receiver_latitude, receiver_longitude)
        if observation and observation.captured_at.astimezone(local_timezone).date().isoformat() == local_date:
            todays_observations.append(observation)

    unique_aircraft = {observation.icao for observation in todays_observations}
    todays_passes = [
        item for item in passes
        if parse_timestamp(item["first_seen"]).astimezone(local_timezone).date().isoformat() == local_date
    ]
    closest = min(
        (observation for observation in todays_observations if observation.distance_km is not None),
        key=lambda observation: observation.distance_km,
        default=None,
    )
    closest_callsign = None
    if closest:
        closest_callsign = next(
            (
                observation.callsign for observation in reversed(todays_observations)
                if observation.icao == closest.icao and observation.callsign
            ),
            None,
        )
    return {
        "date": local_date,
        "unique_aircraft_count": len(unique_aircraft),
        "pass_count": len(todays_passes),
        "closest_aircraft": {
            "icao": closest.icao,
            "callsign": closest_callsign,
            "distance_km": round(closest.distance_km, 3),
            "at": isoformat(closest.captured_at),
        } if closest else None,
    }


def required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigurationError(f"Required environment variable is missing: {name}")
    return value


def coordinate_environment(name: str, minimum: float, maximum: float) -> float:
    value = required_environment(name)
    try:
        number = float(value)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be a number") from error
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ConfigurationError(f"{name} is outside the allowed range")
    return number


def integer_environment(name: str, default: int, minimum: int, maximum: int) -> int:
    value = os.environ.get(name)
    if value is None:
        return default
    try:
        number = int(value)
    except ValueError as error:
        raise ConfigurationError(f"{name} must be an integer") from error
    if not minimum <= number <= maximum:
        raise ConfigurationError(f"{name} is outside the allowed range")
    return number


def build_snapshot(now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    receiver_latitude = coordinate_environment("SKYSCOPE_RECEIVER_LATITUDE", -90, 90)
    receiver_longitude = coordinate_environment("SKYSCOPE_RECEIVER_LONGITUDE", -180, 180)
    aircraft_path = os.environ.get("SKYSCOPE_AIRCRAFT_PATH", DEFAULT_AIRCRAFT_PATH)
    database_path = os.environ.get("SKYSCOPE_DATABASE_PATH", DEFAULT_DATABASE_PATH)
    lookback_hours = integer_environment("SKYSCOPE_LOOKBACK_HOURS", 48, 24, 168)
    pass_limit = integer_environment("SKYSCOPE_PASS_LIMIT", 50, 1, MAX_RECENT_PASSES)
    timezone_name = os.environ.get("SKYSCOPE_TIMEZONE", "Europe/Helsinki")
    try:
        local_timezone = ZoneInfo(timezone_name)
    except ZoneInfoNotFoundError as error:
        raise ConfigurationError(f"Unknown SKYSCOPE_TIMEZONE: {timezone_name}") from error

    local_now = now.astimezone(local_timezone)
    day_start_local = datetime.combine(local_now.date(), datetime.min.time(), tzinfo=local_timezone)
    since = min(now - timedelta(hours=lookback_hours), day_start_local.astimezone(timezone.utc)) - PASS_GAP
    raw_observations = read_observations(database_path, since)
    passes = group_passes(raw_observations, receiver_latitude, receiver_longitude)
    captured_at, aircraft = build_current_aircraft(
        read_aircraft_json(aircraft_path), receiver_latitude, receiver_longitude, now
    )
    return {
        "schema_version": 1,
        "captured_at": captured_at,
        "aircraft": aircraft,
        "passes": passes[:pass_limit],
        "stats": build_stats(
            passes, raw_observations, receiver_latitude, receiver_longitude,
            local_now.date().isoformat(), local_timezone
        ),
    }


def send_snapshot(snapshot: Mapping[str, Any]) -> None:
    api_url = required_environment("SKYSCOPE_API_URL")
    token = required_environment("SKYSCOPE_INGEST_TOKEN")
    timeout = integer_environment("SKYSCOPE_HTTP_TIMEOUT_SECONDS", 10, 2, 60)
    body = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    request = urllib.request.Request(
        api_url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "SkyScope-Pi-Exporter/1",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        if response.status < 200 or response.status >= 300:
            raise RuntimeError(f"Worker returned HTTP {response.status}")
        response.read(64 * 1024)


def main() -> int:
    parser = argparse.ArgumentParser(description="Send one SkyScope snapshot to the configured Worker.")
    parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        snapshot = build_snapshot()
    except (ConfigurationError, OSError, ValueError, sqlite3.Error) as error:
        LOGGER.error("Snapshot could not be built: %s", error)
        return 1
    try:
        send_snapshot(snapshot)
    except urllib.error.HTTPError as error:
        LOGGER.error("Worker rejected the snapshot with HTTP %s", error.code)
        return 1
    except (urllib.error.URLError, TimeoutError, RuntimeError, OSError) as error:
        LOGGER.error("Snapshot delivery failed: %s", error)
        return 1
    LOGGER.info(
        "Snapshot delivered: aircraft=%s passes=%s date=%s",
        len(snapshot["aircraft"]), len(snapshot["passes"]), snapshot["stats"]["date"]
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
