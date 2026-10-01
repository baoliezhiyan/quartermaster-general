import io
import unittest

from scripts.ppo_progress import ProgressDisplay, ordinal


class TtyBuffer(io.StringIO):
    def isatty(self):
        return True


class ProgressDisplayTests(unittest.TestCase):
    def test_update_progress_reuses_one_terminal_line(self):
        output = TtyBuffer()
        with ProgressDisplay("A 第一轮 · 第一次更新", 40, stream=output, interval=10) as display:
            display.update(28)
            display.set_stage("优化中")
            display.update(40)
        text = output.getvalue()
        self.assertIn("28/40", text)
        self.assertIn("40/40", text)
        self.assertIn("优化中", text)
        self.assertIn("完成", text)
        self.assertEqual(text.count("\n"), 1)
        self.assertEqual(ordinal(2, "轮"), "第二轮")

    def test_failure_is_visible_without_falsely_completing_tasks(self):
        output = io.StringIO()
        with self.assertRaisesRegex(RuntimeError, "failed"):
            with ProgressDisplay("B 第一轮 · 第一次更新", 40, stream=output) as display:
                display.update(11)
                raise RuntimeError("failed")
        self.assertIn("11/40", output.getvalue())
        self.assertIn("失败", output.getvalue())


if __name__ == "__main__":
    unittest.main()
