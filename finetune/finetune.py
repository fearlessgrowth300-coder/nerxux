"""
Fine-tune an open base model on YOUR data -> your own working model.

This runs on a GPU (Google Colab's free T4 is enough). It takes a small open
model that ALREADY knows how to code and chat (Qwen2.5), and trains it further
on your instruction data (finetune/data/train.jsonl) using LoRA -- a method that
only updates a tiny set of new weights, so it fits in free Colab memory.

Result: YOUR fine-tuned model. It can code and chat (from the base), with your
data's flavor baked in (from the fine-tune).

HOW TO RUN (see finetune/README.md for the click-by-click version):
  1. Open Google Colab -> new notebook -> Runtime -> Change runtime type -> T4 GPU
  2. Upload train.jsonl and this file
  3. pip install the requirements (see README), then:  python finetune.py
  4. Download the resulting `nexus-finetuned/` folder

This is NOT meant to run on the local CPU machine -- it needs a GPU.
"""

import os

import torch
from datasets import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer
from peft import LoraConfig
from trl import SFTTrainer, SFTConfig

# --- choose your base ----------------------------------------------------
# 0.5B   = fastest, runs almost anywhere afterward (even a weak PC, quantized)
# Coder  = better at code, a bit larger
BASE_MODEL = os.environ.get("BASE_MODEL", "Qwen/Qwen2.5-0.5B-Instruct")
DATA = os.environ.get("DATA", "data/train.jsonl")
OUT = os.environ.get("OUT", "nexus-finetuned")


def main():
    if not torch.cuda.is_available():
        print("WARNING: no GPU detected. This will be extremely slow / may not "
              "fit in RAM. Run this on Google Colab with a T4 GPU.")

    print(f"Loading base model: {BASE_MODEL}")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL)
    model = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
        device_map="auto",
    )

    # Format each example with the model's chat template into a single string.
    ds = load_dataset("json", data_files=DATA, split="train")

    def to_text(ex):
        return {"text": tokenizer.apply_chat_template(
            ex["messages"], tokenize=False, add_generation_prompt=False)}

    ds = ds.map(to_text, remove_columns=ds.column_names)
    print(f"Examples: {len(ds)}")

    # LoRA: only train small adapter matrices (cheap, fits free Colab).
    peft_config = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj",
                        "gate_proj", "up_proj", "down_proj"],
    )

    cfg = SFTConfig(
        output_dir=OUT,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        num_train_epochs=3,
        learning_rate=2e-4,
        logging_steps=10,
        save_strategy="epoch",
        bf16=torch.cuda.is_available(),
        dataset_text_field="text",
        max_seq_length=1024,
        report_to="none",
    )

    trainer = SFTTrainer(
        model=model,
        tokenizer=tokenizer,
        train_dataset=ds,
        peft_config=peft_config,
        args=cfg,
    )
    trainer.train()

    # Save the LoRA adapter, then merge it into the base for a standalone model.
    trainer.save_model(OUT)
    print(f"Saved LoRA adapter -> {OUT}")

    print("Merging adapter into base for a standalone model...")
    from peft import AutoPeftModelForCausalLM
    merged = AutoPeftModelForCausalLM.from_pretrained(OUT, torch_dtype=torch.bfloat16)
    merged = merged.merge_and_unload()
    merged.save_pretrained(OUT + "-merged")
    tokenizer.save_pretrained(OUT + "-merged")
    print(f"Done. Standalone model -> {OUT}-merged/")
    print("Next: download it, convert to GGUF, and run via Ollama (see README).")


if __name__ == "__main__":
    main()
