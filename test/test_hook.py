"""Tests for hooks/hook.py (the WSL/Linux hook). Run: python3 -m unittest discover -s test"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HOOK = Path(__file__).resolve().parent.parent / "hooks" / "hook.py"


class HookTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.spool = Path(self.tmp.name) / "spool"
        self.spool.mkdir()
        source = HOOK.read_text(encoding="utf-8")
        source = source.replace('"__SPOOL__"', json.dumps(str(self.spool)))
        source = source.replace('"__PLATFORM__"', json.dumps("wsl:test"))
        self.script = Path(self.tmp.name) / "hook.py"
        self.script.write_text(source, encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def run_hook(self, payload):
        data = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        result = subprocess.run([sys.executable, str(self.script)], input=data,
                                capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")  # must never print anything Codex could interpret
        return [json.loads(p.read_text(encoding="utf-8")) for p in sorted(self.spool.glob("*.json"))]

    def test_stop_becomes_complete(self):
        records = self.run_hook({"hook_event_name": "Stop", "session_id": "s", "turn_id": "t",
                                 "cwd": "/home/u/项目", "last_assistant_message": "完成了\n  两处修改"})
        self.assertEqual(len(records), 1)
        r = records[0]
        self.assertEqual((r["kind"], r["session"], r["turn"], r["cwd"], r["platform"]),
                         ("complete", "s", "t", "/home/u/项目", "wsl:test"))
        self.assertEqual(r["summary"], "完成了 两处修改")

    def test_request_user_input_becomes_input(self):
        records = self.run_hook({"hook_event_name": "PreToolUse", "session_id": "s", "turn_id": "t",
                                 "cwd": "/p", "tool_name": "functions.request_user_input", "tool_use_id": "c1",
                                 "tool_input": {"questions": [{"header": "H", "question": "选哪个？"}]}})
        self.assertEqual([(r["kind"], r["id"], r["summary"]) for r in records], [("input", "c1", "选哪个？")])

    def test_permission_request_becomes_approval(self):
        records = self.run_hook({"hook_event_name": "PermissionRequest", "session_id": "s", "turn_id": "t",
                                 "cwd": "/p", "tool_name": "shell", "tool_input": {"command": ["rm", "-rf", "build"]}})
        self.assertEqual([(r["kind"], r["summary"]) for r in records], [("approval", "rm -rf build")])

    def test_summary_is_truncated(self):
        records = self.run_hook({"hook_event_name": "Stop", "session_id": "s", "turn_id": "t", "cwd": "/p",
                                 "last_assistant_message": "x" * 5000})
        self.assertEqual(len(records[0]["summary"]), 200)

    def test_stops_writing_when_spool_is_full(self):
        for i in range(500):
            (self.spool / f"old-{i}.json").write_text("{}")
        self.run_hook({"hook_event_name": "Stop", "session_id": "s", "turn_id": "t", "cwd": "/p"})
        self.assertEqual(len(list(self.spool.iterdir())), 500)

    def test_ignored_inputs(self):
        for payload in ({"hook_event_name": "Stop", "agent_id": "sub", "session_id": "s", "turn_id": "t", "cwd": "/p"},
                        {"hook_event_name": "PreToolUse", "tool_name": "shell", "session_id": "s", "turn_id": "t", "cwd": "/p"},
                        {"hook_event_name": "PostToolUse", "session_id": "s", "turn_id": "t", "cwd": "/p"},
                        b"not json", b""):
            self.assertEqual(self.run_hook(payload), [])
        self.assertEqual(list(self.spool.iterdir()), [])  # no temp files left behind


if __name__ == "__main__":
    unittest.main()
