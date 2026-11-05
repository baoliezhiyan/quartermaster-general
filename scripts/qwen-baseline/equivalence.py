"""Compare both CUDA BF16 paths using identical weights and cached token histories."""
from contextlib import nullcontext
import hashlib

# BF16 unit roundoff is about 0.004 near 1. Fused versus unfused accumulation
# can amplify it across 24 blocks. Require small whole-vocabulary RMS and
# probability error as well as overlap; permit a small number of outliers.
TOLERANCE = {"maxAbsLogit": 0.75, "rmsLogit": 0.15, "jensenShannon": 0.003, "minTop5Overlap": 3}
STEPS = 5


def compare(model, encoded, tokenizer, attention_context):
    import torch
    from transformers import GenerationConfig, LogitsProcessorList
    from transformers.integrations import sdpa_attention
    from transformers.models.qwen3_5 import modeling_qwen3_5 as implementation

    if encoded["input_ids"].shape[-1] > 384:
        raise ValueError("Reference comparison limited to a 384-token input")
    layers = [m for m in model.modules() if isinstance(m, implementation.Qwen3_5GatedDeltaNet)]
    if not layers or any(layer.causal_conv1d_fn is None for layer in layers):
        raise RuntimeError("Comparison requires the configured accelerated backend")
    keys = ("causal_conv1d_fn", "chunk_gated_delta_rule", "recurrent_gated_delta_rule", "norm")
    fast = [tuple(getattr(layer, key) for key in keys) for layer in layers]
    gqa = sdpa_attention.use_gqa_in_sdpa
    config = GenerationConfig(do_sample=False, num_beams=1, max_new_tokens=STEPS, min_new_tokens=STEPS,
        use_cache=True, return_dict_in_generate=True, output_logits=True,
        pad_token_id=tokenizer.pad_token_id, eos_token_id=model.generation_config.eos_token_id)
    encoded = encoded.to("cuda:0")

    def run(context, prefix=None):
        def force(input_ids, scores):
            index = input_ids.shape[-1] - encoded["input_ids"].shape[-1]
            token = prefix[index]
            forced = torch.full_like(scores, -torch.inf)
            forced[:, token] = 0
            return forced
        processors = LogitsProcessorList([force] if prefix is not None else [])
        with context(), torch.inference_mode():
            result = model.generate(**encoded, generation_config=config, logits_processor=processors)
        return result.sequences[0, -STEPS:].tolist(), [v[0].float().cpu() for v in result.logits]

    try:
        sdpa_attention.use_gqa_in_sdpa = lambda mask, key: mask is None
        for layer in layers:
            layer.causal_conv1d_fn = None
            layer.chunk_gated_delta_rule = implementation.torch_chunk_gated_delta_rule
            layer.recurrent_gated_delta_rule = implementation.torch_recurrent_gated_delta_rule
            norm = implementation.Qwen3_5RMSNormGated(layer.head_v_dim, eps=layer.layer_norm_epsilon)
            norm.weight = layer.norm.weight
            layer.norm = norm
        ref_tokens, ref_logits = run(nullcontext)
    finally:
        for layer, values in zip(layers, fast):
            for key, value in zip(keys, values):
                setattr(layer, key, value)
        sdpa_attention.use_gqa_in_sdpa = gqa

    fast_tokens, fast_logits = run(attention_context)
    if fast_tokens != ref_tokens:
        _, fast_logits = run(attention_context, ref_tokens)

    rows = []
    for index, (a, b) in enumerate(zip(ref_logits, fast_logits)):
        diff = (a - b).abs()
        p, q = a.softmax(-1), b.softmax(-1)
        midpoint = (p + q) / 2
        js = ((torch.special.xlogy(p, p)-torch.special.xlogy(p, midpoint)).sum() +
              (torch.special.xlogy(q, q)-torch.special.xlogy(q, midpoint)).sum()) / 2
        top_a, top_b = a.topk(5).indices.tolist(), b.topk(5).indices.tolist()
        rows.append({"step": index, "phase": "prefill" if index == 0 else "cached_decode",
            "maxAbsLogit": float(diff.max()), "rmsLogit": float(diff.square().mean().sqrt()),
            "jensenShannon": float(js), "top5Overlap": len(set(top_a) & set(top_b)),
            "referenceTop": [[i, float(p[i])] for i in top_a], "acceleratedTop": [[i, float(q[i])] for i in top_b]})
    numeric_pass = len(rows) == STEPS and all(
        r["maxAbsLogit"] <= TOLERANCE["maxAbsLogit"] and r["rmsLogit"] <= TOLERANCE["rmsLogit"] and
        r["jensenShannon"] <= TOLERANCE["jensenShannon"] and r["top5Overlap"] >= TOLERANCE["minTop5Overlap"]
        for r in rows)
    return {"inputTokens": encoded["input_ids"].shape[-1],
        "inputTokenSha256": hashlib.sha256(str(encoded["input_ids"][0].tolist()).encode()).hexdigest(),
        "tolerance": TOLERANCE, "numericPass": numeric_pass, "greedyEqual": ref_tokens == fast_tokens,
        "referenceGreedy": ref_tokens, "acceleratedGreedy": fast_tokens,
        "referenceText": tokenizer.decode(ref_tokens), "acceleratedText": tokenizer.decode(fast_tokens), "steps": rows}
