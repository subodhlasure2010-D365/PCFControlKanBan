import { KanbanCardData, KanbanColumnData, StageOption } from "../types";
import { DEFAULT_PALETTE, FALLBACK_COLOR } from "./MetadataService";
import { baseKey } from "./CurrencyService";

type DataSet = ComponentFramework.PropertyTypes.DataSet;

const ALIAS_TITLE = "title";
const ALIAS_GROUP = "groupBy";
const ALIAS_VALUE = "cardValue";
const ALIAS_VALUE_BASE = "cardValueBase";
const ALIAS_DATE = "cardDate";
const EXTRA_ALIASES = [
    "extraField1",
    "extraField2",
    "extraField3",
    "extraField4",
    "extraField5",
    "extraField6",
];

/** Resolves the real logical name behind a property-set alias. */
export function getColumnLogicalName(dataset: DataSet, alias: string): string | null {
    const col = dataset.columns.find((c) => c.alias === alias);
    return col ? col.name : null;
}

export function hasColumn(dataset: DataSet, aliasOrName: string): boolean {
    return dataset.columns.some((c) => c.alias === aliasOrName || c.name === aliasOrName);
}

/**
 * Logical name of the base-currency twin of the Card Value column
 * (estimatedvalue -> estimatedvalue_base). Null when Card Value is unbound.
 */
export function getBaseFieldLogicalName(dataset: DataSet): string | null {
    const valueName = getColumnLogicalName(dataset, ALIAS_VALUE);
    if (!valueName) {
        return null;
    }
    return valueName.endsWith("_base") ? valueName : `${valueName}_base`;
}

/**
 * Where the base amount can be read from on the dataset record, in order:
 *   1. the "cardValueBase" property-set, when the maker bound it
 *   2. "<cardValue>_base", when that column happens to be on the view
 * Null means neither is available - the caller then fetches the values.
 */
export function resolveBaseColumn(dataset: DataSet): string | null {
    if (dataset.columns.some((c) => c.alias === ALIAS_VALUE_BASE)) {
        return ALIAS_VALUE_BASE;
    }
    const derived = getBaseFieldLogicalName(dataset);
    if (derived && hasColumn(dataset, derived)) {
        return derived;
    }
    return null;
}

export function buildCards(
    dataset: DataSet,
    ownerColumn: string,
    overrides: Record<string, number>,
    baseColumn: string | null,
    baseValues: Record<string, number>
): KanbanCardData[] {
    const cards: KanbanCardData[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const ownerAvailable = ownerColumn !== "" && hasColumn(dataset, ownerColumn);
    const valueAvailable = hasColumn(dataset, ALIAS_VALUE);
    const dateAvailable = hasColumn(dataset, ALIAS_DATE);

    // Resolve the extra-field slots that the maker actually bound to a column.
    const extraCols: { alias: string; label: string }[] = [];
    for (const alias of EXTRA_ALIASES) {
        const col = dataset.columns.find((c) => c.alias === alias);
        if (col) {
            extraCols.push({ alias, label: col.displayName || col.name });
        }
    }

    // Every column on the view, addressed the way getFormattedValue expects
    // (alias when the column is bound to a property-set, otherwise the logical
    // name). Used to build the searchable text of each card, so the toolbar
    // filter matches Account, Opportunity ID / Number and any other column the
    // view carries - not just the title and owner.
    const searchCols: string[] = [];
    for (const col of dataset.columns) {
        const key = col.alias || col.name;
        if (key && searchCols.indexOf(key) === -1) {
            searchCols.push(key);
        }
    }

    for (const id of dataset.sortedRecordIds) {
        const record = dataset.records[id];
        if (!record) {
            continue;
        }

        const title = record.getFormattedValue(ALIAS_TITLE) || "(no name)";

        let groupValue: number | null = null;
        if (Object.prototype.hasOwnProperty.call(overrides, id)) {
            groupValue = overrides[id];
        } else {
            const raw = record.getValue(ALIAS_GROUP);
            if (raw !== null && raw !== undefined && raw !== "") {
                const n = Number(raw);
                groupValue = isNaN(n) ? null : n;
            }
        }

        const ownerName = ownerAvailable ? record.getFormattedValue(ownerColumn) || "" : "";

        let valueRaw = 0;
        let valueFormatted = "";
        if (valueAvailable) {
            const v = record.getValue(ALIAS_VALUE);
            valueRaw = typeof v === "number" ? v : Number(v) || 0;
            valueFormatted = record.getFormattedValue(ALIAS_VALUE) || "";
        }

        // Amount in the org base currency - column totals are built from this
        // so that records in SAR, KWD and USD can legitimately be added up.
        let valueBase: number | null = null;
        if (baseColumn !== null) {
            const b = record.getValue(baseColumn);
            const n = typeof b === "number" ? b : Number(b);
            valueBase = isNaN(n) ? 0 : n;
        } else {
            const fetched = baseValues[baseKey(id)];
            valueBase = fetched === undefined ? null : fetched;
        }

        let dateFormatted = "";
        let isOverdue = false;
        if (dateAvailable) {
            dateFormatted = record.getFormattedValue(ALIAS_DATE) || "";
            const rawDate = record.getValue(ALIAS_DATE);
            if (rawDate) {
                const d = rawDate instanceof Date ? rawDate : new Date(String(rawDate));
                if (!isNaN(d.getTime()) && d < today) {
                    isOverdue = true;
                }
            }
        }

        const extraFields = extraCols
            .map((col) => ({
                label: col.label,
                value: record.getFormattedValue(col.alias) || "",
            }))
            .filter((f) => f.value !== "");

        cards.push({
            id,
            title,
            ownerName,
            ownerInitials: initials(ownerName),
            valueFormatted,
            valueRaw,
            valueBase,
            dateFormatted,
            isOverdue,
            groupValue,
            extraFields,
            searchText: buildSearchText(record, id, title, ownerName, searchCols),
            reference: record.getNamedReference(),
        });
    }
    return cards;
}

/**
 * Lower-cased text the toolbar filter runs against: record id (with and
 * without dashes, so a pasted GUID matches either way), title, owner, and the
 * formatted value of every column on the view. Built once per dataset load, so
 * typing in the search box only scans strings.
 */
function buildSearchText(
    record: ComponentFramework.PropertyHelper.DataSetApi.EntityRecord,
    id: string,
    title: string,
    ownerName: string,
    searchCols: string[]
): string {
    const cleanId = id.replace(/[{}]/g, "");
    const parts: string[] = [cleanId, cleanId.replace(/-/g, ""), title, ownerName];
    for (const col of searchCols) {
        let value = "";
        try {
            value = record.getFormattedValue(col) || "";
        } catch {
            /* column not readable on this record - skip it */
        }
        if (value !== "") {
            parts.push(value);
        }
    }
    return parts.join(" ").toLowerCase();
}

export function buildColumns(
    cards: KanbanCardData[],
    options: StageOption[],
    formatMoney: (value: number) => string,
    useBase: boolean
): KanbanColumnData[] {
    let stageOptions = options;

    // Fallback: derive columns from the values present in the data
    if (stageOptions.length === 0) {
        const seen = new Map<number, string>();
        for (const card of cards) {
            if (card.groupValue !== null && !seen.has(card.groupValue)) {
                seen.set(card.groupValue, `Stage ${card.groupValue}`);
            }
        }
        stageOptions = Array.from(seen.entries()).map(([value, label], i) => ({
            value,
            label,
            color: DEFAULT_PALETTE[i % DEFAULT_PALETTE.length],
        }));
    }

    const columns: KanbanColumnData[] = stageOptions.map((o) => ({
        value: o.value,
        label: o.label,
        color: o.color,
        cards: [],
        sum: 0,
        sumFormatted: "",
    }));

    const byValue = new Map<number, KanbanColumnData>();
    for (const col of columns) {
        if (col.value !== null) {
            byValue.set(col.value, col);
        }
    }

    let unassigned: KanbanColumnData | null = null;
    for (const card of cards) {
        let target = card.groupValue !== null ? byValue.get(card.groupValue) : undefined;
        if (!target) {
            if (!unassigned) {
                unassigned = {
                    value: null,
                    label: "Unassigned",
                    color: FALLBACK_COLOR,
                    cards: [],
                    sum: 0,
                    sumFormatted: "",
                };
            }
            target = unassigned;
        }
        target.cards.push(card);
        target.sum += useBase ? (card.valueBase ?? 0) : card.valueRaw;
    }
    if (unassigned) {
        columns.push(unassigned);
    }

    for (const col of columns) {
        col.sumFormatted = col.sum > 0 ? formatMoney(col.sum) : "";
    }
    return columns;
}

function initials(name: string): string {
    if (!name) {
        return "";
    }
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
        return parts[0].substring(0, 2).toUpperCase();
    }
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export { ALIAS_TITLE, ALIAS_GROUP, ALIAS_VALUE, ALIAS_VALUE_BASE, ALIAS_DATE };