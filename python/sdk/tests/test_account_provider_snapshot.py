"""Project historical account cancellation notifications through the Python SDK."""
from __future__ import annotations

import json
from pathlib import Path

from deepseek_harness.api import final_response, finish_reason

ROOT = Path(__file__).resolve().parents[3]


def test_account_provider_signout_snapshot() -> None:
    capture = ROOT / 'snapshots' / 'sdk' / 'account-provider-signout' / 'notifications.expected.jsonl'
    notifications = [json.loads(line) for line in capture.read_text(encoding='utf-8').splitlines()]
    events = [notification['params']['event'] for notification in notifications if notification['method'] == 'session.event']
    ending = next(event for event in reversed(events) if event['type'] == 'turn/end')
    actual = {
        'final_response': final_response(events),
        'finish_reason': finish_reason(events),
        'reason': ending['data']['reason'],
    }
    expected = Path(__file__).with_name('expected') / 'account-provider-signout.json'
    assert actual == json.loads(expected.read_text(encoding='utf-8'))
