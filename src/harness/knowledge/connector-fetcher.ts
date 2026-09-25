/**
 * ConnectorFetcher — 将 KnowledgeConnector 适配为 SourceFetcher
 */

import type { ResolvedCredential } from '../credentials/types.js';
import type { DiscoveredDocRef, SourceFetcher, VirtualDocument } from './fetchers.js';
import type { ConnectorRegistry } from './connectors.js';
import type { KnowledgeSource } from './types.js';

export class ConnectorFetcher implements SourceFetcher {
  constructor(private readonly registry: ConnectorRegistry) {}

  async discover(
    source: KnowledgeSource,
    cred?: ResolvedCredential | null,
  ): Promise<DiscoveredDocRef[]> {
    const connector = this.registry.resolve(source);
    return connector.discover(
      {
        location: source.location,
        auth: cred,
        network: source.network,
        maxPages: source.discover?.maxPages,
      },
      source,
    );
  }

  async fetch(
    source: KnowledgeSource,
    ref: DiscoveredDocRef,
    cred?: ResolvedCredential | null,
  ): Promise<VirtualDocument | null> {
    const connector = this.registry.resolve(source);
    return connector.fetch(
      {
        location: source.location,
        auth: cred,
        network: source.network,
        maxPages: source.discover?.maxPages,
      },
      source,
      ref,
    );
  }
}
