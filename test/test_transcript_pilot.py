import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('transcript_pilot', Path(__file__).parents[1] / 'scripts/transcript_pilot.py')
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class CaptionResult:
    language_code = 'en'
    is_generated = True

    def __init__(self, video_id, segments=None):
        self.video_id = video_id
        self.segments = segments if segments is not None else [
            {'text': 'Welcome to the commentary.', 'start': 0.0, 'duration': 2.0},
            {'text': 'Here is the next point.', 'start': 2.0, 'duration': 3.0},
        ]

    def to_raw_data(self):
        return self.segments


class PilotTests(unittest.TestCase):
    def test_three_successes_preserve_timestamps_and_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            summary = pilot.run_pilot(CaptionResult, folder)
            self.assertEqual(summary['retrieved'], 3)
            self.assertNotIn('segments', summary['videos'][0])
            self.assertEqual(summary['videos'][0]['lastCaptionEndSeconds'], 5.0)
            self.assertTrue(summary['videos'][0]['isGenerated'])
            self.assertTrue(summary['videos'][0]['needsEditorialReview'])
            def unexpected(_):
                self.fail('Cached transcript was fetched again')
            self.assertEqual(pilot.run_pilot(unexpected, folder)['retrieved'], 3)

    def test_block_stops_requests_without_claiming_captions_missing(self):
        calls = []
        def blocked(video_id):
            calls.append(video_id)
            raise pilot.PilotFailure('ACCESS_BLOCKED')
        with tempfile.TemporaryDirectory() as folder:
            result = pilot.run_pilot(blocked, folder)
            self.assertEqual(len(calls), 1)
            self.assertEqual([v['status'] for v in result['videos']],
                             ['ACCESS_BLOCKED', 'NOT_ATTEMPTED_AFTER_ACCESS_BLOCK', 'NOT_ATTEMPTED_AFTER_ACCESS_BLOCK'])
            self.assertEqual(result['retrieved'], 0)
            self.assertEqual(len(list(Path(folder).glob('*.json'))), 1)

    def test_missing_captions_does_not_prevent_other_videos(self):
        def fetch(video_id):
            if video_id == pilot.PILOT[0][0]:
                raise pilot.PilotFailure('CAPTIONS_DISABLED')
            return CaptionResult(video_id)
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(pilot.run_pilot(fetch, folder)['retrieved'], 2)

    def test_rejects_empty_malformed_or_wrong_video_transcripts(self):
        for segments in ([], [{'text': '', 'start': 0, 'duration': 1}],
                         [{'text': 'text', 'start': float('nan'), 'duration': 1}],
                         [{'text': 'text', 'start': 9000, 'duration': 1}]):
            with self.assertRaises(pilot.PilotFailure):
                pilot.normalize(CaptionResult('id', segments), 'id', 100)
        with self.assertRaises(pilot.PilotFailure):
            pilot.normalize(CaptionResult('other'), 'id', 100)


if __name__ == '__main__':
    unittest.main()
