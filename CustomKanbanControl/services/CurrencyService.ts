/**
 * Currency helpers for the Kanban board.
 *
 * Dataverse stores every money column twice: the transaction-currency value
 * (what the user typed) and a "<field>_base" value converted to the ORG BASE
 * currency. Microsoft defines the exchange rate as "the value of a transaction
 * currency equal to one base currency", i.e.
 *
 *      base   = transaction / exchangerate
 *      target = base * targetCurrency.exchangerate
 *
 * So a column total in the logged-in user's currency is simply
 *      sum(base values) * userCurrency.exchangerate
 * which is what getUserCurrency() + the caller do together.
 */

export interface UserCurrency {
    id: string;
    symbol: string;
    precision: number;
    /** Units of this currency equal to one org-base-currency unit. */
    exchangeRate: number;
    isoCode: string;
    /** True when the user has no personal currency and we fell back to org base. */
    isOrgBase: boolean;
}

type Ctx = ComponentFramework.Context<unknown>;

const stripBraces = (value: string): string => value.replace(/[{}]/g, "");

/** Normalised record id, used as the key of the fetched base-value map. */
export function baseKey(id: string): string {
    return stripBraces(id).toLowerCase();
}

/**
 * Resolves the currency the totals should be shown in:
 *   1. the logged-in user's personal currency (Personal Options -> Currency)
 *   2. the organisation's base currency, when the user has none
 * Returns null when neither can be read (caller then keeps the old behaviour).
 */
export async function getUserCurrency(context: Ctx): Promise<UserCurrency | null> {
    const webAPI = context.webAPI;
    let currencyId: string | null = null;
    let isOrgBase = false;

    // --- 1. user's personal currency -------------------------------------
    const userId = stripBraces(context.userSettings?.userId ?? "");
    if (userId !== "") {
        try {
            const user = await webAPI.retrieveRecord(
                "systemuser",
                userId,
                "?$select=_transactioncurrencyid_value"
            );
            const value = (user as Record<string, unknown>)["_transactioncurrencyid_value"];
            if (typeof value === "string" && value !== "") {
                currencyId = value;
            }
        } catch {
            /* fall through to org base */
        }
    }

    // --- 2. organisation base currency ------------------------------------
    if (currencyId === null) {
        try {
            const org = await webAPI.retrieveMultipleRecords(
                "organization",
                "?$select=_basecurrencyid_value&$top=1"
            );
            const value = (org.entities[0] as Record<string, unknown> | undefined)?.[
                "_basecurrencyid_value"
            ];
            if (typeof value === "string" && value !== "") {
                currencyId = value;
                isOrgBase = true;
            }
        } catch {
            /* give up */
        }
    }

    if (currencyId === null) {
        return null;
    }

    // --- 3. symbol / precision / rate --------------------------------------
    try {
        const currency = await webAPI.retrieveRecord(
            "transactioncurrency",
            stripBraces(currencyId),
            "?$select=currencysymbol,currencyprecision,exchangerate,isocurrencycode"
        );
        const c = currency as Record<string, unknown>;
        const precision = typeof c.currencyprecision === "number" ? c.currencyprecision : 2;
        const rate = typeof c.exchangerate === "number" && c.exchangerate > 0 ? c.exchangerate : 1;
        return {
            id: stripBraces(currencyId),
            symbol: typeof c.currencysymbol === "string" ? c.currencysymbol : "",
            precision,
            exchangeRate: rate,
            isoCode: typeof c.isocurrencycode === "string" ? c.isocurrencycode : "",
            isOrgBase,
        };
    } catch {
        return null;
    }
}

/** Primary key attribute of the dataset entity (opportunityid, dyn_thingid, ...). */
export async function getPrimaryIdAttribute(context: Ctx, entityName: string): Promise<string> {
    try {
        const md = await context.utils.getEntityMetadata(entityName, []);
        const name = (md as unknown as Record<string, unknown>).PrimaryIdAttribute;
        if (typeof name === "string" && name !== "") {
            return name;
        }
    } catch {
        /* fall back to the convention */
    }
    return `${entityName}id`;
}

/**
 * Retrieves "<field>_base" for the given records when that column is not part
 * of the view. One request per 40 ids; every requested id is seeded with 0 so
 * records with an empty amount still resolve instead of staying pending.
 */
export async function fetchBaseValues(
    context: Ctx,
    entityName: string,
    primaryIdAttribute: string,
    baseField: string,
    recordIds: string[]
): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    const ids = recordIds.map(stripBraces).filter((id) => id !== "");
    const CHUNK = 40;

    for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        for (const id of chunk) {
            result[id.toLowerCase()] = 0; // seed
        }
        const filter = chunk.map((id) => `${primaryIdAttribute} eq ${id}`).join(" or ");
        const response = await context.webAPI.retrieveMultipleRecords(
            entityName,
            `?$select=${primaryIdAttribute},${baseField}&$filter=${filter}`
        );
        for (const entity of response.entities) {
            const row = entity as Record<string, unknown>;
            const id = String(row[primaryIdAttribute] ?? "");
            if (id === "") {
                continue;
            }
            const raw = row[baseField];
            const amount = typeof raw === "number" ? raw : Number(raw);
            result[baseKey(id)] = isNaN(amount) ? 0 : amount;
        }
    }
    return result;
}