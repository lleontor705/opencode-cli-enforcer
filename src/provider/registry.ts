/**
 * Provider registry (REQ-CB-SEAM-001, D11).
 *
 * The registry is the only place that binds provider ids to seam
 * implementations. Core wiring depends on `Provider` values it receives from
 * `resolve()` and never branches on a concrete provider id.
 */

import type { Provider, ProviderId } from "./seams.js";

export interface ProviderRegistry {
  register(provider: Provider): void;
  has(id: ProviderId): boolean;
  get(id: ProviderId): Provider | undefined;
  list(): readonly Provider[];
  /**
   * Bind the enabled provider ids to their registered implementations,
   * preserving declaration order. Throws when an enabled id is not registered.
   */
  resolve(enabled: readonly ProviderId[]): readonly Provider[];
}

export function createProviderRegistry(initial: readonly Provider[] = []): ProviderRegistry {
  const providers = new Map<ProviderId, Provider>();

  const registry: ProviderRegistry = {
    register(provider) {
      if (providers.has(provider.id)) {
        throw new Error(`provider already registered: ${provider.id}`);
      }
      providers.set(provider.id, provider);
    },
    has: (id) => providers.has(id),
    get: (id) => providers.get(id),
    list: () => [...providers.values()],
    resolve(enabled) {
      return enabled.map((id) => {
        const provider = providers.get(id);
        if (!provider) {
          throw new Error(`provider not registered: ${id}`);
        }
        return provider;
      });
    },
  };

  for (const provider of initial) {
    registry.register(provider);
  }
  return registry;
}

export interface ProviderCapabilities {
  readonly id: ProviderId;
  readonly supportsInteractiveApproval: boolean;
  readonly supportsMidTurnSteer: boolean;
}

/**
 * Provider-agnostic core consumer: reads only seam capability flags. Any
 * implementation satisfying `Provider` works here without provider-specific
 * code, which is what the second-provider contract test exercises.
 */
export function inspectCapabilities(provider: Provider): ProviderCapabilities {
  return {
    id: provider.id,
    supportsInteractiveApproval: provider.permissions.supportsInteractiveApproval,
    supportsMidTurnSteer: provider.steering.supportsMidTurnSteer,
  };
}
