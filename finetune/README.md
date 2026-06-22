# Fine-tune YOUR own working model

This makes **your own model that actually codes and chats** — the real-world way.

Instead of growing a brain from zero (which needs a datacenter), you start from
an open model that **already** knows language and code (Qwen2.5), and train it
**on your data** so it becomes *yours*. The result has your fingerprint **and**
it works.

> ⚠️ This needs a **GPU** — it will not run on the local CPU PC. Use **Google
> Colab's free GPU**. Your from-scratch model in `nexus-model/` is unaffected;
> this is a second, working model alongside it.

---

## What you get

- Base brain: `Qwen2.5-0.5B-Instruct` (already codes + chats; small enough to
  run on a normal PC afterward). Swap to `Qwen/Qwen2.5-Coder-1.5B-Instruct` for
  stronger coding if you'll run it in the cloud.
- Trained on: your **732 Stack Overflow Q&A** (real coding questions + answers).
- Output: `nexus-finetuned-merged/` — a standalone model that is *yours*.

---

## Step by step (free, ~20–40 min)

**1. Make the data** (on your PC — no GPU needed):
```bash
python finetune/prepare_data.py        # -> finetune/data/train.jsonl
```

**2. Open Google Colab** → https://colab.research.google.com → **New notebook**.

**3. Turn on the free GPU:** menu **Runtime → Change runtime type → T4 GPU → Save**.

**4. Upload two files** (left sidebar 📁 → upload): `finetune.py` and
`data/train.jsonl` (put train.jsonl in a `data/` folder, or edit the `DATA` path).

**5. In a Colab cell, install + run:**
```python
!pip install transformers==4.44.2 trl==0.9.6 peft==0.12.0 datasets==2.21.0 accelerate==0.33.0 bitsandbytes==0.43.3
!python finetune.py
```
You'll watch the loss go down (real training, on a real model). When it finishes
you'll have a `nexus-finetuned-merged/` folder.

**6. Try it right there in Colab:**
```python
from transformers import pipeline
chat = pipeline("text-generation", model="nexus-finetuned-merged", device_map="auto")
print(chat([{"role":"user","content":"Write a Python function to reverse a string."}],
           max_new_tokens=200)[0]["generated_text"][-1]["content"])
```
This time it will write **actual working code** — because it's a full-scale brain.

---

## Run it back in YOUR Nexus app

Two options:

**A) Easiest — via Ollama (recommended):**
1. In Colab, convert the model to GGUF and download it (the notebook prints the
   exact `llama.cpp` convert command), or push to the Hugging Face Hub.
2. On your PC: `ollama create nexus-mine -f Modelfile` (Modelfile points at the
   GGUF). Then `ollama run nexus-mine`.
3. Point Nexus at it: the `nexus` adapter already calls a local model server —
   set `NEXUS_MODEL_URL=http://localhost:11434` style endpoint, or add a tiny
   Ollama adapter. (Ask and I'll wire this.)

**B) Keep it in the cloud:** push the merged model to Hugging Face and serve it
from there; point `VITE_API_BASE_URL` / the adapter at that endpoint.

---

## Reality check (the honest part)

- **Fine-tuning** = your model, built on a working foundation. This is how people
  actually make "their own AI." It is genuinely yours.
- It runs on **Colab's free GPU**, not your CPU, because real models need a GPU.
- The **0.5B** result can run on a normal PC afterward (quantized). On this
  specific PC (~2.4 GB free RAM) it'll be tight — a quantized 0.5B (~0.5 GB) is
  the realistic size; bigger models are better but want more RAM or the cloud.
- Your hand-built `nexus-model/` stays as **"the model I built from scratch"** —
  this fine-tuned one is **"my model that works."** You keep both.
