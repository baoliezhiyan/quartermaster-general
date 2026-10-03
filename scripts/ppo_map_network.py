"""Optional map-reading network prototype; the A1S1 trainer stays flat by default."""
from __future__ import annotations

import torch
from torch import nn

from scripts.ppo_action_semantics import MAX_ACTION_SLOTS
from scripts.ppo_train import ACTIONS, CANDIDATE_KINDS, PpoNetwork


class PpoMapNetwork(nn.Module):
    architecture = "shared-regions-neighborhood-v1"

    def __init__(self, encoder):
        super().__init__()
        self.base = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
        self.region_count = len(encoder.regions)
        self.country_count = len(encoder.countries)
        self.map_slices = encoder.map_slices
        static_width = len(encoder.static_map_features) // self.region_count
        self.region_width = self.country_count * 3 * 2 + 3 + static_width
        self.region_projection = nn.Sequential(nn.Linear(self.region_width, 64), nn.ReLU())
        self.neighbor_projection = nn.Sequential(nn.Linear(128, 64), nn.ReLU())
        self.slot_weights = nn.Parameter(torch.ones(MAX_ACTION_SLOTS))
        self.map_policy = nn.Sequential(nn.Linear(64 + self.country_count + 256, 128),
                                        nn.ReLU(), nn.Linear(128, 1))
        self.map_value = nn.Sequential(nn.Linear(64 + 256, 128), nn.ReLU(), nn.Linear(128, 1))
        nn.init.zeros_(self.map_policy[-1].weight)
        nn.init.zeros_(self.map_policy[-1].bias)
        nn.init.zeros_(self.map_value[-1].weight)
        nn.init.zeros_(self.map_value[-1].bias)
        adjacency = torch.eye(self.region_count)
        for region, neighbors in encoder.neighbors.items():
            for neighbor in neighbors:
                adjacency[encoder.region_index[region], encoder.region_index[neighbor]] = 1
        adjacency /= adjacency.sum(dim=-1, keepdim=True)
        self.register_buffer("adjacency", adjacency)
        self.semantic_start = encoder.candidate_semantic_start
        self.token_width = (len(ACTIONS) + self.country_count + self.region_count + 3 + 6 +
                            self.country_count + 9)
        self.country_offset = len(ACTIONS)
        self.region_offset = len(ACTIONS) + self.country_count
        self.direct_target_offset = len(CANDIDATE_KINDS) + len(encoder.cards)

    def forward(self, states, candidates, mask):
        logits, value = self.base(states, candidates, mask)
        pieces = [states[:, start:end].reshape(len(states), self.region_count, -1)
                  for start, end in self.map_slices]
        regions = self.region_projection(torch.cat(pieces, dim=-1))
        neighbors = torch.einsum("rs,bsd->brd", self.adjacency, regions)
        regions = self.neighbor_projection(torch.cat((regions, neighbors), dim=-1))
        global_region = regions.mean(dim=1)
        selected = torch.zeros((*candidates.shape[:2], 64), device=candidates.device,
                               dtype=candidates.dtype)
        countries = torch.zeros((*candidates.shape[:2], self.country_count),
                                device=candidates.device, dtype=candidates.dtype)
        total = torch.zeros((*candidates.shape[:2], 1), device=candidates.device,
                            dtype=candidates.dtype)
        for slot in range(MAX_ACTION_SLOTS):
            offset = self.semantic_start + slot * self.token_width
            region_mask = candidates[:, :, offset + self.region_offset:
                                     offset + self.region_offset + self.region_count]
            country_mask = candidates[:, :, offset + self.country_offset:
                                      offset + self.country_offset + self.country_count]
            weight = torch.nn.functional.softplus(self.slot_weights[slot])
            selected += weight * torch.einsum("bnr,brd->bnd", region_mask, regions)
            total += weight * region_mask.sum(dim=-1, keepdim=True)
            countries = torch.maximum(countries, country_mask)
        direct = candidates[:, :, self.direct_target_offset:
                            self.direct_target_offset + self.region_count]
        selected += torch.einsum("bnr,brd->bnd", direct, regions)
        total += direct.sum(dim=-1, keepdim=True)
        selected = torch.where(total.abs() > 1e-6, selected / total.clamp_min(1e-6),
                               global_region[:, None, :])
        state_hidden = self.base.state_net(states)
        map_input = torch.cat((selected, countries,
                               state_hidden[:, None, :].expand(-1, candidates.shape[1], -1)), -1)
        logits = logits + self.map_policy(map_input).squeeze(-1)
        logits = logits.masked_fill(~mask, -1e9)
        value = value + self.map_value(torch.cat((global_region, state_hidden), -1)).squeeze(-1)
        return logits, value


def migrate_flat(flat_model, map_model):
    """Copy all A1S1 flat weights; zero-output map heads preserve initial policy."""
    map_model.base.load_state_dict(flat_model.state_dict())
    return map_model
