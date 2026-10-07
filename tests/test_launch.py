"""Regressions for how Radial is launched (run.cmd and start_hidden.vbs)."""

import sys

import app.main as main_module


def test_main_hands_uvicorn_an_import_string(monkeypatch):
    # Passing the app object while running as __main__ made every POST/PATCH
    # 500 on Python 3.14 + Pydantic 2.13 (request models never finished building).
    calls = []
    monkeypatch.setattr(main_module.uvicorn, "run", lambda target, **kw: calls.append(target))
    main_module.main()
    assert calls == ["app.main:app"]


def test_no_console_logs_to_file_instead_of_crashing(monkeypatch, tmp_path):
    # Under pythonw (start_hidden.vbs) stdout/stderr are None and uvicorn's
    # log formatter crashed at startup, so the hidden launcher never stayed up.
    settings = main_module.get_settings().model_copy(update={"database_path": tmp_path / "radial.db"})
    monkeypatch.setattr(main_module, "get_settings", lambda: settings)
    monkeypatch.setattr(main_module.uvicorn, "run", lambda *a, **kw: None)
    real_out, real_err = sys.stdout, sys.stderr
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)
    try:
        main_module.main()
        assert sys.stdout is not None and sys.stdout.name.endswith("radial.log")
    finally:
        if sys.stdout not in (None, real_out):
            sys.stdout.close()
        sys.stdout, sys.stderr = real_out, real_err
    assert (tmp_path / "radial.log").exists()
