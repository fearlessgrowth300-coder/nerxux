# nexus-model — your own AI model, from scratch

This is a **real, from-scratch language model** for Nexus AI: a small GPT
(decoder-only transformer) with a hand-written autograd engine, a BPE tokenizer,
a full data pipeline, and an HTTP server so the Nexus app can chat with it.

No PyTorch, no TensorFlow, no external API. Just **NumPy + Python**. It trains via
real gradient descent on text *you* provide, on *your* machine.

> Honest scale note: this is the same architecture and training math as the big
> models (GPT/Claude/Gemini), but small — because you have one machine, not a
> datacenter with thousands of GPUs. More data + more steps = better output. It
> will not be GPT‑4; it will be **your** model, and it genuinely learns.

---

## What each piece is (matches the "how models are built" pipeline)

| Stage | File | What it does |
| --- | --- | --- |
| **Collect** | `pipeline/collect_gutenberg.py` | Download public-domain books (legal) |
| **Extract** | `pipeline/extract.py` | PDF/HTML/EPUB/TXT → raw text (rule-based, not AI) |
| **Clean** | `pipeline/clean.py` | Regex + filters: strip page numbers, boilerplate, junk |
| **Dedupe** | `pipeline/dedupe.py` | MinHash near-duplicate removal |
| **Build** | `pipeline/build_corpus.py` | Orchestrates the above → `data/corpus.txt` |
| **Tokenize** | `engine/tokenizer.py` | Byte-Pair Encoding: text → token numbers |
| **Model** | `engine/model.py` | GPT transformer (attention + MLP, next-token prediction) |
| **Learner** | `engine/autograd.py` | Reverse-mode autograd — the chain rule, by hand |
| **Optimize** | `engine/optimizer.py` | Adam — nudges parameters downhill |
| **Train** | `train.py` | The loop: predict → loss → backprop → update → save |
| **Generate** | `engine/generate.py` | Sample text from the trained model |
| **Serve** | `serve.py` | HTTP API so the Nexus app can chat with it |

---

## Quick start

```bash
cd nexus-model
pip install -r requirements.txt

# 1) Get some text to learn from — either:
python -m pipeline.collect_gutenberg --count 20   # legal public-domain books
#    ...or drop your own .txt/.pdf into data/uploads/ (or upload via the app)

# 2) Build a clean corpus
python -m pipeline.build_corpus

# 3) Train your model (watch the loss fall)
python train.py --steps 2000 --n_layer 4 --n_embd 128 --block 64

# 4) Chat with it in the terminal
python chat.py

# 5) ...or serve it to the Nexus app
python serve.py          # http://localhost:4500
```

Then in the Nexus web app: open **Train model** in the sidebar to upload data /
train from the UI, and pick **“Nexus (your model)”** in Chat.

---

## Using it from the Nexus app

The Express server talks to this engine:

- **Train page** (`/train`) → `/api/training/*` → uploads land in `data/uploads/`,
  `build_corpus` and `train.py` run in the background with a live log.
- **Chat** → model id `nexus-local` → server `nexus` adapter → `serve.py` `/chat`.

Set `NEXUS_MODEL_URL` (default `http://localhost:4500`) on the server if you run
the model server elsewhere, and `PYTHON_BIN` if `python` isn't on PATH.

---

## Tuning

| Flag | Meaning | Bigger = |
| --- | --- | --- |
| `--steps` | training iterations | better fit, slower |
| `--n_layer` | transformer blocks | more capacity |
| `--n_embd` | hidden width | more capacity |
| `--block` | context window (tokens) | longer memory |
| `--vocab` | BPE vocabulary size | finer tokens |

Start small (`tiny`/`small`), confirm the loss drops, then scale up data first —
data quality and quantity matter more than model size at this scale.
