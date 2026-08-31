import sys
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from exporter import (
    add_current_altitudes,
    build_current_aircraft,
    group_passes,
    haversine_km,
    read_observations,
)


class ExporterTests(unittest.TestCase):
    def test_haversine_is_about_one_degree_of_latitude(self):
        self.assertAlmostEqual(haversine_km(0, 0, 1, 0), 111.195, places=2)

    def test_gap_over_fifteen_minutes_starts_a_new_pass(self):
        rows = [
            {"captured_at": "2026-08-30T10:00:00Z", "icao": "abc123", "callsign": "FIN1", "latitude": 1.0, "longitude": 0.0},
            {"captured_at": "2026-08-30T10:15:00Z", "icao": "abc123", "callsign": "FIN1", "latitude": 0.8, "longitude": 0.0},
            {"captured_at": "2026-08-30T10:30:01Z", "icao": "abc123", "callsign": "FIN1", "latitude": 0.6, "longitude": 0.0},
        ]
        passes = group_passes(rows, 0.0, 0.0)
        self.assertEqual(len(passes), 2)
        self.assertEqual(passes[1]["first_seen"], "2026-08-30T10:00:00Z")
        self.assertEqual(passes[1]["last_seen"], "2026-08-30T10:15:00Z")

    def test_pass_identifier_stays_stable_when_pass_grows(self):
        first = {"captured_at": "2026-08-30T10:00:00Z", "icao": "abc123", "callsign": None, "latitude": None, "longitude": None}
        second = {"captured_at": "2026-08-30T10:05:00Z", "icao": "abc123", "callsign": "FIN1", "latitude": 1.0, "longitude": 0.0}
        initial_id = group_passes([first], 0.0, 0.0)[0]["id"]
        grown_id = group_passes([first, second], 0.0, 0.0)[0]["id"]
        self.assertEqual(initial_id, grown_id)

    def test_pass_altitude_range_is_collected_without_guessing_missing_values(self):
        rows = [
            {"captured_at": "2026-08-30T10:00:00Z", "icao": "abc123", "callsign": "FIN1", "latitude": 1.0, "longitude": 0.0, "altitude_ft": 12000},
            {"captured_at": "2026-08-30T10:05:00Z", "icao": "abc123", "callsign": "FIN1", "latitude": 0.8, "longitude": 0.0, "altitude_ft": 9000},
        ]

        flight_pass = group_passes(rows, 0.0, 0.0)[0]

        self.assertEqual(flight_pass["min_altitude_ft"], 9000)
        self.assertEqual(flight_pass["max_altitude_ft"], 12000)

    def test_current_readsb_altitude_completes_the_active_pass(self):
        flight_pass = group_passes([
            {"captured_at": "2026-08-30T10:00:00Z", "icao": "abc123", "callsign": "FIN1", "latitude": None, "longitude": None}
        ], 0.0, 0.0)[0]

        add_current_altitudes([flight_pass], [{
            "icao": "ABC123",
            "altitude_ft": 10000,
            "seen_at": "2026-08-30T10:00:20Z",
        }])

        self.assertEqual(flight_pass["min_altitude_ft"], 10000)
        self.assertEqual(flight_pass["max_altitude_ft"], 10000)

    def test_missing_position_is_kept_without_distance(self):
        payload = {
            "now": 1788084000,
            "aircraft": [{
                "hex": "abc123",
                "flight": " FIN1 ",
                "alt_baro": "ground",
                "seen": 1.5,
                "r": " oh-ati ",
                "t": "at75",
                "desc": " ATR 72-500 ",
                "ownOp": " Finnair   Oyj ",
                "dbFlags": 0,
            }],
        }
        _, aircraft = build_current_aircraft(
            payload, 0.0, 0.0, datetime(2026, 8, 30, 10, tzinfo=timezone.utc)
        )
        self.assertEqual(len(aircraft), 1)
        self.assertIsNone(aircraft[0]["latitude"])
        self.assertIsNone(aircraft[0]["longitude"])
        self.assertIsNone(aircraft[0]["distance_km"])
        self.assertEqual(aircraft[0]["callsign"], "FIN1")
        self.assertEqual(aircraft[0]["registration"], "OH-ATI")
        self.assertEqual(aircraft[0]["type_code"], "AT75")
        self.assertEqual(aircraft[0]["type_description"], "ATR 72-500")
        self.assertEqual(aircraft[0]["owner_operator"], "Finnair Oyj")
        self.assertFalse(aircraft[0]["is_military"])
        self.assertNotIn("receiver_latitude", aircraft[0])
        self.assertNotIn("receiver_longitude", aircraft[0])

    def test_military_flag_is_derived_without_exposing_other_database_flags(self):
        payload = {
            "now": 1788084000,
            "aircraft": [{
                "hex": "abc123",
                "dbFlags": 13,
                "seen": 0,
            }],
        }

        _, aircraft = build_current_aircraft(
            payload, 0.0, 0.0, datetime(2026, 8, 30, 10, tzinfo=timezone.utc)
        )

        self.assertTrue(aircraft[0]["is_military"])
        self.assertNotIn("db_flags", aircraft[0])

    def test_missing_aircraft_database_fields_remain_unknown(self):
        payload = {
            "now": 1788084000,
            "aircraft": [{"hex": "abc123", "seen": 0}],
        }

        _, aircraft = build_current_aircraft(
            payload, 0.0, 0.0, datetime(2026, 8, 30, 10, tzinfo=timezone.utc)
        )

        self.assertIsNone(aircraft[0]["registration"])
        self.assertIsNone(aircraft[0]["type_code"])
        self.assertIsNone(aircraft[0]["type_description"])
        self.assertIsNone(aircraft[0]["owner_operator"])
        self.assertIsNone(aircraft[0]["is_military"])

    def test_sqlite_reader_supports_unix_and_iso_timestamps(self):
        with tempfile.TemporaryDirectory() as directory:
            database_path = Path(directory) / "observations.sqlite"
            connection = sqlite3.connect(database_path)
            connection.execute(
                """
                CREATE TABLE observations (
                    captured_at, icao TEXT, callsign TEXT,
                    latitude REAL, longitude REAL, altitude_ft REAL
                )
                """
            )
            connection.executemany(
                "INSERT INTO observations VALUES (?, ?, ?, ?, ?, ?)",
                [
                    (datetime(2026, 8, 30, 10, tzinfo=timezone.utc).timestamp(), "ABC123", "FIN1", 1.0, 0.0, 12000),
                    ("2026-08-30T10:05:00Z", "DEF456", "FIN2", None, None, None),
                    (datetime(2026, 8, 20, 10, tzinfo=timezone.utc).timestamp(), "OLD123", None, None, None, None),
                ],
            )
            connection.commit()
            connection.close()

            rows = read_observations(
                str(database_path), datetime(2026, 8, 29, 10, tzinfo=timezone.utc)
            )

            self.assertEqual({row["icao"] for row in rows}, {"ABC123", "DEF456"})
            self.assertEqual(rows[0]["altitude_ft"], 12000)


if __name__ == "__main__":
    unittest.main()
