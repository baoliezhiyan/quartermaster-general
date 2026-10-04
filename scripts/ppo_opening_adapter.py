"""Training-only contextual residual learned from the fixed opening demonstration.

The prototype is the encoded *state and candidate* from a verified label. It
does not identify a card by its name or grant a global card bonus. The map PPO
network remains intact and can be trained normally after adaptation.
"""
from __future__ import annotations

import torch
from torch import nn

from scripts.ppo_map_network import PpoMapNetwork


class PpoOpeningAdapter(nn.Module):
    architecture = "map-contextual-opening-adapter-v1"

    def __init__(self, encoder):
        super().__init__()
        self.map = PpoMapNetwork(encoder)
        self.register_buffer("prototype_state", torch.zeros(encoder.state_dim))
        self.register_buffer("prototype_candidate", torch.zeros(encoder.candidate_dim))
        self.register_buffer("state_scale", torch.ones(()))
        self.register_buffer("candidate_scale", torch.ones(()))
        self.opening_logit = nn.Parameter(torch.zeros(()))

    def set_prototype(self, state, candidate, state_scale, candidate_scale):
        if state_scale <= 0 or candidate_scale <= 0:
            raise ValueError("The opening prototype must be separated from controls")
        with torch.no_grad():
            self.prototype_state.copy_(state.to(self.prototype_state))
            self.prototype_candidate.copy_(candidate.to(self.prototype_candidate))
            self.state_scale.fill_(state_scale)
            self.candidate_scale.fill_(candidate_scale)

    def forward(self, states, candidates, mask):
        logits, value = self.map(states, candidates, mask)
        state_distance = (states - self.prototype_state).square().sum(-1)
        candidate_distance = (candidates - self.prototype_candidate).square().sum(-1)
        gate = torch.exp(-state_distance[:, None] / self.state_scale -
                         candidate_distance / self.candidate_scale)
        logits = (logits + self.opening_logit * gate).masked_fill(~mask, -1e9)
        return logits, value


class A2S1MapAdapter(PpoOpeningAdapter):
    """The new observation/action schema requires an explicit architecture ID."""
    architecture = "map-contextual-opening-adapter-a2s1-v1"
