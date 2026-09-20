# README visuals

These assets are local to the repository; GitHub needs no external image service.

- `sliding-window.gif` is an animated explanation using text and scores from the [mixed fixture](../../apps/speech-filter-harness/fixtures/ambient/mixed.json). It shows the four-word ambient prefix being excluded, a directed suffix beginning at zero-based `startIndex = 4`, and one chat submission after the default 1,500 ms debounce. Fixture labels are scripted; this is an illustration, not a recording or a model-quality benchmark. Evaluation snapshots and presentation timing are simplified, not an exact fixture event trace; the countdown lasts 1,500 ms.
- `sliding-window-poster.png` is the animation's final frame, for a static reading option.
- `ui-panel-map.svg` maps the [demo UI](../../apps/speech-filter-harness/src/ui/page.ts). It is a schematic, not a screenshot. The model selector controls live Gateway STT; fixture replay does not call STT.
- `pipeline.mmd` and `ambient-directed.mmd` are the Mermaid sources for the diagrams embedded in the main README. Update those copies together.

Regenerate the GIF, poster, and UI map from the repository root:

```sh
python3 -m venv /tmp/jevis-doc-assets
/tmp/jevis-doc-assets/bin/python -m pip install Pillow==11.3.0
/tmp/jevis-doc-assets/bin/python scripts/generate-doc-assets.py
```

Python/Pillow are optional documentation tools and are not required to run Jevis. The generator uses Arial on macOS/Windows or DejaVu Sans on Linux; `--font-dir` can point to either font family. It requires no API keys or network access after Pillow is installed. Each generated asset must stay under 1.5 MB; the script checks this budget.

The example uses the fixture's 96% Choice / 97% Boolean scores and the current 60% confidence defaults. Ambient decisions advance `excludedBefore`; `startIndex` remains `null` until a directed suffix qualifies. New transcript content invalidates the previous decision and resets debounce; unclear, failed, or stale decisions do not permit a submit.
