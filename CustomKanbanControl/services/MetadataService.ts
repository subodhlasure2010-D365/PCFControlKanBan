import { StageOption } from "../types";

const DEFAULT_PALETTE = [
    "#7A3DB8", // purple
    "#C19C00", // gold
    "#038387", // teal
    "#5B5F66", // grey
    "#0F6CBD", // blue
    "#C43E1C", // rust
    "#0E700E", // green
    "#B4009E", // magenta
];

/**
 * Resolves the options (value, label, color) of a choice / status column.
 * 1. Tries context.utils.getEntityMetadata (supported PCF API).
 * 2. Falls back to a raw org Web API metadata request (model-driven apps only).
 * 3. Returns [] if neither works — the board then derives columns from the data.
 */
export async function getChoiceOptions(
    context: ComponentFramework.Context<unknown>,
    entityName: string,
    attributeName: string
): Promise<StageOption[]> {
    // --- Path 1: getEntityMetadata -------------------------------------
    try {
        const md = await context.utils.getEntityMetadata(entityName, [attributeName]);
        const attributes = (md as unknown as Record<string, unknown>).Attributes as
            | { getByName?: (name: string) => unknown; get?: (name: string) => unknown }
            | undefined;
        const attr =
            attributes?.getByName?.(attributeName) ?? attributes?.get?.(attributeName);
        const options = extractOptionsFromAttribute(attr);
        if (options.length > 0) {
            return applyPalette(options);
        }
    } catch {
        // fall through to raw metadata request
    }

    // --- Path 2: raw Web API metadata request --------------------------
    try {
        const base = getClientUrl(context);
        const casts = [
            "Microsoft.Dynamics.CRM.PicklistAttributeMetadata",
            "Microsoft.Dynamics.CRM.StatusAttributeMetadata",
            "Microsoft.Dynamics.CRM.StateAttributeMetadata",
            "Microsoft.Dynamics.CRM.MultiSelectPicklistAttributeMetadata",
        ];
        for (const cast of casts) {
            const url =
                `${base}/api/data/v9.2/EntityDefinitions(LogicalName='${entityName}')` +
                `/Attributes(LogicalName='${attributeName}')/${cast}` +
                `?$select=LogicalName&$expand=OptionSet($select=Options)`;
            const res = await fetch(url, {
                headers: {
                    Accept: "application/json",
                    "OData-MaxVersion": "4.0",
                    "OData-Version": "4.0",
                },
                credentials: "same-origin",
            });
            if (!res.ok) {
                continue;
            }
            const json = (await res.json()) as {
                OptionSet?: {
                    Options?: {
                        Value: number;
                        Color?: string;
                        Label?: { UserLocalizedLabel?: { Label?: string } };
                    }[];
                };
            };
            const raw = json.OptionSet?.Options ?? [];
            const options: StageOption[] = raw.map((o) => ({
                value: o.Value,
                label: o.Label?.UserLocalizedLabel?.Label ?? String(o.Value),
                color: o.Color ?? "",
            }));
            if (options.length > 0) {
                return applyPalette(options);
            }
        }
    } catch {
        // give up — board will derive columns from data
    }

    return [];
}

function extractOptionsFromAttribute(attr: unknown): StageOption[] {
    if (!attr) {
        return [];
    }
    const a = attr as Record<string, unknown>;
    const candidates: unknown[] = [
        a.OptionSet,
        (a.attributeDescriptor as Record<string, unknown> | undefined)?.OptionSet,
        (a.OptionSet as Record<string, unknown> | undefined)?.Options,
    ];
    for (const candidate of candidates) {
        const arr = normalizeOptionArray(candidate);
        if (arr.length > 0) {
            return arr;
        }
    }
    return [];
}

function normalizeOptionArray(candidate: unknown): StageOption[] {
    if (!candidate) {
        return [];
    }
    const list: unknown[] = Array.isArray(candidate)
        ? candidate
        : typeof (candidate as { forEach?: unknown }).forEach === "function"
          ? Array.prototype.slice.call(candidate as ArrayLike<unknown>)
          : [];
    const result: StageOption[] = [];
    for (const item of list) {
        const o = item as Record<string, unknown>;
        const value = typeof o.Value === "number" ? o.Value : typeof o.value === "number" ? (o.value as number) : null;
        if (value === null) {
            continue;
        }
        let label = "";
        if (typeof o.Label === "string") {
            label = o.Label;
        } else if (typeof o.text === "string") {
            label = o.text as string;
        } else {
            const lbl = o.Label as { UserLocalizedLabel?: { Label?: string } } | undefined;
            label = lbl?.UserLocalizedLabel?.Label ?? String(value);
        }
        const color = typeof o.Color === "string" ? (o.Color as string) : typeof o.color === "string" ? (o.color as string) : "";
        result.push({ value, label, color });
    }
    return result;
}

function applyPalette(options: StageOption[]): StageOption[] {
    return options.map((o, i) => ({
        ...o,
        color: o.color && o.color !== "" ? o.color : DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
    }));
}

export function getClientUrl(context: ComponentFramework.Context<unknown>): string {
    const page = (context as unknown as { page?: { getClientUrl?: () => string } }).page;
    if (page?.getClientUrl) {
        return page.getClientUrl();
    }
    const xrm = (window as unknown as { Xrm?: { Utility?: { getGlobalContext?: () => { getClientUrl: () => string } } } }).Xrm;
    if (xrm?.Utility?.getGlobalContext) {
        return xrm.Utility.getGlobalContext().getClientUrl();
    }
    return window.location.origin;
}

export const FALLBACK_COLOR = "#5B5F66";
export { DEFAULT_PALETTE };
