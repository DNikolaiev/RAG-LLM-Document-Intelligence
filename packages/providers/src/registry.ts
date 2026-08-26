import type { Provider, ProviderCapabilities } from './ports.js';

export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>();

  register(provider: Provider): this {
    const { id } = provider.capabilities();
    if (!id.trim()) throw new Error('Provider id is required');
    if (this.#providers.has(id)) throw new Error(`Provider already registered: ${id}`);
    this.#providers.set(id, provider);
    return this;
  }

  resolve<T extends Provider>(id: string, requiredFeatures: readonly string[] = []): T {
    const provider = this.#providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    const missing = requiredFeatures.filter(
      (feature) => !provider.capabilities().features.includes(feature),
    );
    if (missing.length) throw new Error(`Provider ${id} lacks capabilities: ${missing.join(', ')}`);
    return provider as T;
  }

  select<T extends Provider>(ids: readonly string[], requiredFeatures: readonly string[] = []): T {
    const errors: string[] = [];
    for (const id of ids) {
      try {
        return this.resolve<T>(id, requiredFeatures);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`No compatible provider configured. ${errors.join('; ')}`);
  }

  catalog(): ProviderCapabilities[] {
    return [...this.#providers.values()]
      .map((provider) => provider.capabilities())
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
