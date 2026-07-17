import { ToolDecorator as Tool, ResourceDecorator as Resource, ExecutionContext, z, Module } from '@nitrostack/core';
import { store, Asset } from '../../lib/store.js';

export class AssetTools {
  @Tool({
    name: 'register_asset',
    description:
      'Register a physical asset (factory, warehouse, supplier, office, datacenter, port) that Atlas should monitor for threats. ' +
      'WHEN TO USE: the user asks to add/register/monitor a facility, plant, supplier or site — e.g. "register our textile supplier in Gaziantep at 37.07, 37.38". ' +
      'Requires a name and coordinates; if the user gives only a city, estimate its lat/lon yourself and pass them in. ' +
      'WHEN NOT TO USE: querying existing assets (list_assets) or removing one (remove_asset). Registering an existing name replaces it.',
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
      'WHEN TO USE: the user asks "what am I monitoring?", or you need an asset name that the user did not provide or gave ambiguously. ' +
      'WHEN NOT TO USE: do NOT call this before forecast_at or check_asset_exposure when the user already supplied an exact asset name — ' +
      'those tools take the name directly (case-insensitive) and return known_assets themselves if it does not match. ' +
      'Also not needed before threat_sweep, which already covers every monitored asset.',
    inputSchema: z.object({}),
  })
  async listAssets(_input: unknown, ctx: ExecutionContext) {
    const assets = store.listAssets();
    ctx.logger.info('Listing assets', { count: assets.length });
    return { count: assets.length, assets };
  }

  @Tool({
    name: 'remove_asset',
    description:
      'Stop monitoring an asset: delete it from the Atlas registry by name. ' +
      'WHEN TO USE: the user asks to remove, delete, deregister, unregister, decommission, or stop monitoring/tracking a site — ' +
      'e.g. "remove the decommissioned Osaka warehouse". Matching is case-insensitive; a unique partial name also works. ' +
      'Call directly with the name the user gave — do NOT call list_assets first; an unknown name returns known_assets so you can recover. ' +
      'WHEN NOT TO USE: adding a site (register_asset) or viewing sites (list_assets). Removal is permanent — the asset must be re-registered to monitor it again.',
    inputSchema: z.object({ name: z.string().describe('Asset name as the user said it (case-insensitive; unique partial names accepted)') }),
  })
  async removeAsset(input: { name: string }, ctx: ExecutionContext) {
    let removedName = store.getAsset(input.name)?.name ?? input.name;
    let ok = store.removeAsset(input.name);
    if (!ok) {
      // Fuzzy fallback: a unique case-insensitive substring match also counts.
      const needle = input.name.trim().toLowerCase();
      const candidates = store.listAssets().filter(
        (a) => a.name.toLowerCase().includes(needle) || needle.includes(a.name.toLowerCase())
      );
      if (candidates.length === 1) {
        removedName = candidates[0].name;
        ok = store.removeAsset(removedName);
      } else if (candidates.length > 1) {
        return {
          error: `'${input.name}' is ambiguous — matches ${candidates.length} assets.`,
          candidates: candidates.map((a) => a.name),
          hint: 'Call remove_asset again with the exact name.',
        };
      }
    }
    if (!ok) {
      return {
        error: `No asset named '${input.name}'.`,
        known_assets: store.assetNames(),
      };
    }
    ctx.logger.info('Removed asset', { name: removedName });
    return { removed: removedName, remaining: store.assetNames() };
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
