import { ToolDecorator as Tool, ResourceDecorator as Resource, ExecutionContext, z, Module } from '@nitrostack/core';
import { store, Asset } from '../../lib/store.js';

export class AssetTools {
  @Tool({
    name: 'register_asset',
    description:
      'Register a physical asset (factory, warehouse, supplier, office, datacenter, port) that Atlas should monitor for threats. ' +
      'Use whenever the user mentions a facility, plant, supplier or site they care about. ' +
      'Requires a name and coordinates; if the user gives only a city, estimate its lat/lon yourself and pass them in.',
    inputSchema: z.object({
      name: z.string().describe('Human-friendly asset name, e.g. "Hsinchu Chip Supplier"'),
      lat: z.number().min(-90).max(90).describe('Latitude in decimal degrees'),
      lon: z.number().min(-180).max(180).describe('Longitude in decimal degrees'),
      type: z.enum(['office', 'warehouse', 'supplier', 'factory', 'datacenter', 'port']),
      notes: z.string().optional().describe('Optional context, e.g. what it supplies'),
    }),
  })
  async registerAsset(input: Asset, ctx: ExecutionContext) {
    ctx.logger.info('Registering asset', { name: input.name });
    const existed = !!store.getAsset(input.name);
    const asset = store.addAsset(input);
    return {
      registered: asset,
      replaced_existing: existed,
      total_assets: store.listAssets().length,
      message: `Asset '${asset.name}' is now under Atlas watch.`,
    };
  }

  @Tool({
    name: 'list_assets',
    description:
      'List every asset currently monitored by Atlas, with coordinates and type. ' +
      'Use to answer "what am I monitoring?" or before threat assessments when the user refers to "my assets/factories/suppliers".',
    inputSchema: z.object({}),
  })
  async listAssets(_input: unknown, ctx: ExecutionContext) {
    const assets = store.listAssets();
    ctx.logger.info('Listing assets', { count: assets.length });
    return { count: assets.length, assets };
  }

  @Tool({
    name: 'remove_item',
    description: "Stop monitoring an asset (kind='asset') or delete an alert contact (kind='contact'), by exact name. " +
      'Use when the user asks to remove/deregister a site or a contact.',
    inputSchema: z.object({ kind: z.enum(['asset', 'contact']), name: z.string() }),
  })
  async removeItem(input: { kind: 'asset' | 'contact'; name: string }, ctx: ExecutionContext) {
    if (input.kind === 'asset') {
      const ok = store.removeAsset(input.name);
      ctx.logger.info('remove asset', { name: input.name, ok });
      return ok ? { removed: input.name, remaining: store.assetNames() }
        : { error: `No asset named '${input.name}'.`, known_assets: store.assetNames() };
    }
    const ok = store.removeContact(input.name);
    ctx.logger.info('remove contact', { name: input.name, ok });
    return ok ? { removed: input.name }
      : { error: `No contact '${input.name}'.`, known_contacts: store.listContacts().map((c) => c.name) };
  }
}

export class AssetResources {
  @Resource({
    uri: 'atlas://assets',
    name: 'Monitored Assets',
    description: 'Live registry of every physical asset Atlas is watching (name, coordinates, type).',
    mimeType: 'application/json',
  })
  async assets(uri: string, ctx: ExecutionContext) {
    ctx.logger.info('Serving atlas://assets');
    return {
      contents: [
        { uri, mimeType: 'application/json', text: JSON.stringify({ assets: store.listAssets() }, null, 2) },
      ],
    };
  }
}

@Module({
  name: 'assets',
  description: 'Asset registry: the facilities Atlas protects',
  controllers: [AssetTools, AssetResources],
})
export class AssetsModule {}
