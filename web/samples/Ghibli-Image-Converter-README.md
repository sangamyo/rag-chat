# Ghibli Image Converter

**▶ Live demo:** https://sangamyo.github.io/ghibli-image-converter/ (runs in your browser; photos are never uploaded)

Turns a photo into a hand-painted, Ghibli-inspired scene with flat colour regions, clean outlines and cel-style shading. It uses the **AnimeGANv3 "Hayao" model** (a GAN trained on the look of Hayao Miyazaki's films), exported to ONNX, and runs the same model from a Python command-line tool and from a static web app.

![Original photos on the left, converted versions on the right](docs/preview.jpg)

## How it works

1. **Resize:** the longest side is capped (default 768 px), then both sides are snapped to a multiple of 8 and at least 256 px, as the model requires.
2. **Normalise:** RGB pixels are scaled to `[-1, 1]` as a `1 × H × W × 3` float32 tensor.
3. **Infer:** ONNX Runtime runs the generator.
4. **Restore:** the output is mapped back to `0–255` and resized to the original photo size.

A smaller working size gives a stronger painted look, because the model paints at a fixed scale in pixels. A larger one keeps more detail. The web app exposes this as *Strong* (512), *Balanced* (768) and *Detailed* (1024).

## Command line

```sh
pip install -r requirements.txt
python -m ghibli_converter photo.jpg more_photos/ -o output
python -m ghibli_converter samples --max-side 512      # stronger style
```

Results are saved as `output/<name>_ghibli.png` at the original size (`--model-size` keeps the model's size instead). EXIF rotation, PNG transparency and greyscale images are handled.

Use it from Python:

```python
from PIL import Image
from ghibli_converter import GhibliConverter

converter = GhibliConverter()
converter.convert(Image.open("photo.jpg"), max_side=768).save("photo_ghibli.png")
```

## Web app

`web/index.html` is a single static page that runs the model with [ONNX Runtime Web](https://onnxruntime.ai/). It uses **WebGPU** when available (about 0.3–1 s per photo) and falls back to **WebAssembly** (about 1–3 s). It has drag-and-drop upload, sample photos, a before/after slider and a PNG download. Everything runs on your device.

Run it locally:

```sh
mkdir -p web/models web/samples && cp models/*.onnx web/models/ && cp samples/*.jpg web/samples/
python -m http.server -d web 8000     # open http://localhost:8000
```

Every push to `main` runs the tests and deploys the site to GitHub Pages (`.github/workflows/`).

## Project layout

```
ghibli_converter/   core.py (pre/post-processing + ONNX inference), cli.py
models/             AnimeGANv3_Hayao_36.onnx (4 MB)
web/                static browser app
samples/            CC0 test photos (see samples/CREDITS.md)
tests/              pytest: sizing rules, tensor round-trip, EXIF, end-to-end run
```

## Tests

```sh
pip install pytest && pytest -q
```

## Credits and licenses

- **Model:** [AnimeGANv3](https://github.com/TachibanaYoshino/AnimeGANv3) by Asher Chan (`AnimeGANv3_Hayao_36.onnx`, from the official v1.1.0 release). It is free for **non-commercial** use under the author's license; commercial use needs the author's permission. This project is a non-commercial demo.
- **Code:** MIT, see [LICENSE](LICENSE). The MIT license does not cover the model file.
- **Sample photos:** public domain (CC0), from Wikimedia Commons. See [samples/CREDITS.md](samples/CREDITS.md).
- "Ghibli-inspired" describes the visual style. This project is not affiliated with or endorsed by Studio Ghibli.
