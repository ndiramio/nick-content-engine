"""Manual three-video public-caption pilot; never invoked by the hourly detector."""
import argparse
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys

PILOT = (
    ('LgWKZ3Zkmgw', 3693),
    ('GcZ0PXabwt0', 1918),
    ('37CUChtKyAg', 588),
)
PROVIDER = 'youtube-transcript-api/1.2.4'


class PilotFailure(Exception):
    def __init__(self, status):
        self.status = status


def normalize(result, video_id, duration):
    """Validate timed source material before it can be used for an article."""
    segments = result.to_raw_data()
    if not segments or result.video_id != video_id:
        raise PilotFailure('INVALID_TRANSCRIPT')
    previous_start = -1
    for segment in segments:
        text = segment.get('text')
        start, length = segment.get('start'), segment.get('duration')
        if (not isinstance(text, str) or not text.strip()
                or not isinstance(start, (int, float)) or not math.isfinite(start)
                or not isinstance(length, (int, float)) or not math.isfinite(length)
                or start < previous_start or start < 0 or length < 0
                or start + length > duration + 15):
            raise PilotFailure('INVALID_TRANSCRIPT')
        previous_start = start
    if result.language_code not in ('en', 'en-US', 'en-GB'):
        raise PilotFailure('NO_ENGLISH_CAPTIONS')
    return {
        'status': 'RETRIEVED', 'videoId': video_id,
        'sourceUrl': f'https://www.youtube.com/watch?v={video_id}',
        'provider': PROVIDER, 'language': result.language_code,
        'isGenerated': result.is_generated, 'segments': segments,
        'segmentCount': len(segments),
        'wordCount': sum(len(s['text'].split()) for s in segments),
        'lastCaptionEndSeconds': max(s['start'] + s['duration'] for s in segments),
        'videoDurationSeconds': duration,
        'retrievedAt': datetime.now(timezone.utc).isoformat(),
        'needsEditorialReview': True,
    }


def atomic_json(path, value):
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


def run_pilot(fetch, output_dir):
    """One sequential attempt per allowlisted video; stop on infrastructure blocks."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    outcomes = []
    blocked = False
    for video_id, duration in PILOT:
        path = output_dir / f'{video_id}.json'
        # A completed output is immutable in this pilot. Do not silently overwrite it.
        if path.exists():
            saved = json.loads(path.read_text(encoding='utf-8'))
            if saved.get('videoId') != video_id or saved.get('status') != 'RETRIEVED':
                raise PilotFailure('INVALID_SAVED_TRANSCRIPT')
            outcome = {k: v for k, v in saved.items() if k != 'segments'}
            outcome['cached'] = True
        elif blocked:
            outcome = {'videoId': video_id, 'status': 'NOT_ATTEMPTED_AFTER_ACCESS_BLOCK'}
        else:
            try:
                saved = normalize(fetch(video_id), video_id, duration)
                atomic_json(path, saved)
                outcome = {k: v for k, v in saved.items() if k != 'segments'}
            except PilotFailure as error:
                outcome = {'videoId': video_id, 'status': error.status}
                blocked = error.status == 'ACCESS_BLOCKED'
        outcomes.append(outcome)
    summary = {
        'event': 'transcript_pilot_completed', 'dryRun': True,
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'provider': PROVIDER, 'videos': outcomes,
        'retrieved': sum(v['status'] == 'RETRIEVED' for v in outcomes),
    }
    atomic_json(output_dir / 'summary.json', summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', default='data/transcript-pilot')
    args = parser.parse_args()
    # Imported only by the network runner; offline tests have no dependencies.
    from requests import Session
    from youtube_transcript_api import YouTubeTranscriptApi
    from youtube_transcript_api._errors import (
        RequestBlocked, IpBlocked, TranscriptsDisabled, NoTranscriptFound,
        VideoUnavailable, VideoUnplayable, AgeRestricted,
    )

    class TimedSession(Session):
        def request(self, *args, **kwargs):
            kwargs.setdefault('timeout', (10, 30))
            return super().request(*args, **kwargs)

    with TimedSession() as session:
        api = YouTubeTranscriptApi(http_client=session)

        def fetch(video_id):
            try:
                return api.fetch(video_id, languages=['en', 'en-US', 'en-GB'])
            except (RequestBlocked, IpBlocked):
                raise PilotFailure('ACCESS_BLOCKED') from None
            except TranscriptsDisabled:
                raise PilotFailure('CAPTIONS_DISABLED') from None
            except NoTranscriptFound:
                raise PilotFailure('NO_ENGLISH_CAPTIONS') from None
            except (VideoUnavailable, VideoUnplayable, AgeRestricted):
                raise PilotFailure('VIDEO_UNAVAILABLE') from None
            except Exception:
                # Raw errors may contain request URLs. Never emit them.
                raise PilotFailure('FETCH_FAILED') from None

        summary = run_pilot(fetch, args.output_dir)
        print(json.dumps(summary))
        return 0 if summary['retrieved'] == len(PILOT) else 2


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        print(json.dumps({'event': 'transcript_pilot_failed', 'dryRun': True,
                          'reason': 'pilot_configuration_or_storage_error'}))
        sys.exit(1)
