"""Trainable map branch with historical actor-specific strait adjacency."""
from __future__ import annotations

import torch
from torch import nn

from scripts.ppo_action_semantics import MAX_ACTION_SLOTS
from scripts.ppo_train import ACTIONS, CANDIDATE_KINDS, PpoNetwork, TARGET_SLOTS


class PpoMapNetwork(nn.Module):
    architecture = "shared-regions-actor-adjacency-ordered-actions-v2"

    def __init__(self, encoder):
        super().__init__()
        self.base = PpoNetwork(encoder.state_dim, encoder.candidate_dim)
        self.region_count = len(encoder.regions)
        self.country_count = len(encoder.countries)
        self.map_slices = encoder.map_slices
        self.effective_straits_start = encoder.effective_straits_start
        self.strait_count = len(encoder.schema["straits"])
        static_width = len(encoder.static_map_features) // self.region_count
        self.region_width = self.country_count * 3 * 2 + 3 + static_width
        self.region_projection = nn.Sequential(nn.Linear(self.region_width, 64), nn.ReLU())
        self.slot_projection = nn.Sequential(nn.Linear(128 + len(ACTIONS) +
                                                     self.country_count + 3, 96), nn.ReLU())
        self.ordered_actions = nn.GRU(96, 96, batch_first=True)
        self.ordered_targets = nn.GRU(64 + self.country_count, 64, batch_first=True)
        self.map_policy = nn.Sequential(nn.Linear(96 + 64 + 64 + 256, 128),
                                        nn.ReLU(), nn.Linear(128, 1))
        self.map_value = nn.Sequential(nn.Linear(64 + 256, 128), nn.ReLU(), nn.Linear(128, 1))
        nn.init.zeros_(self.map_policy[-1].weight)
        nn.init.zeros_(self.map_policy[-1].bias)
        nn.init.zeros_(self.map_value[-1].weight)
        nn.init.zeros_(self.map_value[-1].bias)
        adjacency = torch.eye(self.region_count)
        for a, b in encoder.schema["baseEdges"]:
            i, j = encoder.region_index[a], encoder.region_index[b]
            adjacency[i, j] = adjacency[j, i] = 1
        straits = torch.zeros(self.strait_count, self.region_count, self.region_count)
        for index, strait in enumerate(encoder.schema["straits"]):
            i, j = encoder.region_index[strait["seaA"]], encoder.region_index[strait["seaB"]]
            straits[index, i, j] = straits[index, j, i] = 1
        self.register_buffer("base_adjacency", adjacency)
        self.register_buffer("strait_edges", straits)
        self.semantic_start = encoder.candidate_semantic_start
        self.action_slots = encoder.max_action_slots
        self.token_width = (len(ACTIONS) + self.country_count + self.region_count + 3 + 6 +
                            self.country_count + 9)
        self.country_offset = len(ACTIONS)
        self.region_offset = len(ACTIONS) + self.country_count
        self.direct_target_offset = len(CANDIDATE_KINDS) + len(encoder.cards)
        self.ordered_target_start = (self.direct_target_offset + self.region_count +
                                     self.country_count + 4)
        self.ordered_target_width = 1 + self.country_count + 3

    def _actor_neighbors(self, states, regions):
        batch = states.shape[0]
        flags = states[:, self.effective_straits_start:
                       self.effective_straits_start + self.country_count * self.strait_count]
        flags = flags.reshape(batch, self.country_count, self.strait_count)
        adjacency = self.base_adjacency[None, None] + torch.einsum(
            "bcs,sij->bcij", flags, self.strait_edges)
        adjacency = adjacency / adjacency.sum(-1, keepdim=True).clamp_min(1)
        return torch.einsum("bcij,bjd->bcid", adjacency, regions)

    def forward(self, states, candidates, mask):
        logits, value = self.base(states, candidates, mask)
        batch, count = candidates.shape[:2]
        pieces = [states[:, start:end].reshape(batch, self.region_count, -1)
                  for start, end in self.map_slices]
        regions = self.region_projection(torch.cat(pieces, -1))
        neighbors = self._actor_neighbors(states, regions)
        slots = self.action_slots
        tokens = candidates[:, :, self.semantic_start:
                            self.semantic_start + slots * self.token_width]
        tokens = tokens.reshape(batch, count, slots, self.token_width)
        actions = tokens[..., :len(ACTIONS)]
        countries = tokens[..., self.country_offset:
                           self.country_offset + self.country_count]
        targets = tokens[..., self.region_offset:
                         self.region_offset + self.region_count]
        has_target = targets.sum(-1, keepdim=True).clamp(max=1)
        actor_present = countries.sum(-1, keepdim=True).clamp(max=1)
        target_region = torch.einsum("bnsr,brd->bnsd", targets, regions)
        # Keep the full target and actor distributions; the contraction is
        # split only to reduce the intermediate search cost of einsum.
        target_neighborhoods = torch.einsum("bnsr,bcrd->bnscd", targets, neighbors)
        actor_neighborhood = (target_neighborhoods * countries[..., None]).sum(-2)
        present = (actions.sum(-1, keepdim=True) + actor_present).clamp(max=1)
        features = torch.cat((target_region, actor_neighborhood, actions, countries,
                              has_target, actor_present, present), -1)
        sequence = self.slot_projection(features).reshape(batch * count, slots, -1)
        _, hidden = self.ordered_actions(sequence)
        ordered = hidden[-1].reshape(batch, count, -1)
        direct = candidates[:, :, self.direct_target_offset:
                            self.direct_target_offset + self.region_count]
        direct_region = torch.einsum("bnr,brd->bnd", direct, regions)
        ordered_data = candidates[:, :, self.ordered_target_start:
                                  self.ordered_target_start + TARGET_SLOTS * self.ordered_target_width]
        ordered_data = ordered_data.reshape(batch, count, TARGET_SLOTS, self.ordered_target_width)
        region_codes = ordered_data[..., 0]
        valid_targets = (region_codes > 0).to(regions.dtype)
        # Existing ordered target encoding is (region index + 1)/R per slot.
        region_ids = (region_codes * self.region_count).round().long().clamp(1, self.region_count) - 1
        batch_ids = torch.arange(batch, device=states.device)[:, None, None]
        ordered_regions = regions[batch_ids, region_ids] * valid_targets[..., None]
        ordered_input = torch.cat((ordered_regions,
            ordered_data[..., 1:1 + self.country_count]), -1)
        _, target_hidden = self.ordered_targets(ordered_input.reshape(
            batch * count, TARGET_SLOTS, -1))
        ordered_target_context = target_hidden[-1].reshape(batch, count, -1)
        ordered_target_context = ordered_target_context * valid_targets.any(-1)[..., None]
        state_hidden = self.base.state_net(states)
        map_input = torch.cat((ordered, direct_region, ordered_target_context,
                               state_hidden[:, None].expand(-1, count, -1)), -1)
        logits = (logits + self.map_policy(map_input).squeeze(-1)).masked_fill(~mask, -1e9)
        value = value + self.map_value(torch.cat((regions.mean(1), state_hidden), -1)).squeeze(-1)
        return logits, value


def migrate_flat(flat_model, map_model):
    """Copy all A1S1 flat weights; zero-output map heads preserve initial policy."""
    map_model.base.load_state_dict(flat_model.state_dict())
    return map_model
