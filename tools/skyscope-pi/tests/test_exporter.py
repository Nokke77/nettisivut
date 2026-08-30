import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from exporter import build_current_aircraft, group_passes, haversine_km


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

    def test_missing_position_is_kept_without_distance(self):
        payload = {
            "now": 1788084000,
            "aircraft": [{"hex": "abc123", "flight": " FIN1 ", "alt_baro": "ground", "seen": 1.5}],
        }
        _, aircraft = build_current_aircraft(
            payload, 0.0, 0.0, datetime(2026, 8, 30, 10, tzinfo=timezone.utc)
        )
        self.assertEqual(len(aircraft), 1)
        self.assertIsNone(aircraft[0]["latitude"])
        self.assertIsNone(aircraft[0]["longitude"])
        self.assertIsNone(aircraft[0]["distance_km"])
        self.assertEqual(aircraft[0]["callsign"], "FIN1")
        self.assertNotIn("receiver_latitude", aircraft[0])
        self.assertNotIn("receiver_longitude", aircraft[0])


if __name__ == "__main__":
    unittest.main()
