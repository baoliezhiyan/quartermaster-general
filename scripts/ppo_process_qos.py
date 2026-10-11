"""Optional, process-local Windows QoS diagnostic and reversible speed setting.

Never changes priority class, affinity, power plan, registry, timer resolution or
another application's process. A parent process setting is not assumed to
propagate to Node workers: callers apply this to each worker PID explicitly.
"""
from __future__ import annotations

import ctypes
import os
from contextlib import contextmanager

PROCESS_POWER_THROTTLING = 4
EXECUTION_SPEED = 1
PROCESS_SET_INFORMATION = 0x0200
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class PowerThrottlingState(ctypes.Structure):
    _fields_ = [("Version", ctypes.c_ulong), ("ControlMask", ctypes.c_ulong),
                ("StateMask", ctypes.c_ulong)]


def _kernel():
    if os.name != "nt":
        return None
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.GetProcessInformation.argtypes = [ctypes.c_void_p, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_ulong]
    kernel.SetProcessInformation.argtypes = [ctypes.c_void_p, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_ulong]
    kernel.GetPriorityClass.argtypes = [ctypes.c_void_p]
    kernel.GetPriorityClass.restype = ctypes.c_ulong
    return kernel


def _read(kernel, handle):
    state = PowerThrottlingState()
    state.Version = 1
    if not kernel.GetProcessInformation(handle, PROCESS_POWER_THROTTLING,
                                        ctypes.byref(state), ctypes.sizeof(state)):
        raise OSError(ctypes.get_last_error(), "GetProcessInformation failed")
    return state


def query(pid):
    kernel = _kernel()
    if kernel is None:
        return {"pid": pid, "supported": False, "reason": "not_windows"}
    handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return {"pid": pid, "supported": False,
                "reason": f"OpenProcess:{ctypes.get_last_error()}"}
    try:
        state = _read(kernel, handle)
        return {"pid": pid, "supported": True, "version": state.Version,
                "controlMask": state.ControlMask, "stateMask": state.StateMask,
                "executionSpeedControlled": bool(state.ControlMask & EXECUTION_SPEED),
                "executionSpeedThrottled": bool(state.StateMask & EXECUTION_SPEED),
                "priorityClass": kernel.GetPriorityClass(handle)}
    except (AttributeError, OSError) as error:
        return {"pid": pid, "supported": False, "reason": str(error)}
    finally:
        kernel.CloseHandle(handle)


@contextmanager
def disable_execution_speed_throttling(pid):
    """Opt-in HighQoS request on one training PID, restoring exact masks at exit."""
    kernel = _kernel()
    if kernel is None:
        yield {"pid": pid, "applied": False, "reason": "not_windows"}
        return
    handle = kernel.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_INFORMATION,
                                False, pid)
    if not handle:
        yield {"pid": pid, "applied": False,
               "reason": f"OpenProcess:{ctypes.get_last_error()}"}
        return
    original = None
    try:
        try:
            original = _read(kernel, handle)
            changed = PowerThrottlingState(1, original.ControlMask | EXECUTION_SPEED,
                                           original.StateMask & ~EXECUTION_SPEED)
            if not kernel.SetProcessInformation(handle, PROCESS_POWER_THROTTLING,
                                                ctypes.byref(changed), ctypes.sizeof(changed)):
                raise OSError(ctypes.get_last_error(), "SetProcessInformation failed")
            current = _read(kernel, handle)
            applied = bool(current.ControlMask & EXECUTION_SPEED) and not bool(
                current.StateMask & EXECUTION_SPEED)
            status = {"pid": pid, "applied": applied,
                      "before": {"controlMask": original.ControlMask,
                                 "stateMask": original.StateMask},
                      "after": {"controlMask": current.ControlMask,
                                "stateMask": current.StateMask},
                      "priorityClass": kernel.GetPriorityClass(handle)}
        except (AttributeError, OSError) as error:
            status = {"pid": pid, "applied": False, "reason": str(error)}
        yield status
    finally:
        if original is not None:
            if not kernel.SetProcessInformation(handle, PROCESS_POWER_THROTTLING,
                                                ctypes.byref(original), ctypes.sizeof(original)):
                status["restoreError"] = ctypes.get_last_error()
            else:
                restored = _read(kernel, handle)
                status["restored"] = (restored.ControlMask == original.ControlMask and
                                      restored.StateMask == original.StateMask)
        kernel.CloseHandle(handle)
