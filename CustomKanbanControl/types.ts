export interface KanbanExtraField {
    label: string;
    value: string;
}

export interface KanbanCardData {
    id: string;
    title: string;
    ownerName: string;
    ownerInitials: string;
    valueFormatted: string;
    valueRaw: number;
    /**
     * Amount in the ORG BASE currency ("<field>_base"), used for the column
     * totals. null = not resolved yet (base column absent and fetch pending).
     */
    valueBase: number | null;
    dateFormatted: string;
    isOverdue: boolean;
    groupValue: number | null;
    extraFields: KanbanExtraField[];
    /**
     * Lower-cased blob of everything searchable on this record: the record id
     * (GUID), the title, the owner, and the formatted value of EVERY column on
     * the view — so the toolbar filter also matches Account, Opportunity ID /
     * Opportunity Number, topic, etc. Built once per dataset load.
     */
    searchText: string;
    reference: ComponentFramework.EntityReference;
}

export interface StageOption {
    value: number;
    label: string;
    color: string;
}

export interface KanbanColumnData {
    value: number | null;
    label: string;
    color: string;
    cards: KanbanCardData[];
    sum: number;
    sumFormatted: string;
}