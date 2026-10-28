import * as React from "react";
import { MissingStageFields } from "../services/Bpfrequiredservice";

export interface RequiredFieldsDialogProps {
    recordTitle: string;
    targetStage: string;
    accentColor: string;
    missing: MissingStageFields[];
    onOpenRecord: () => void;
    onClose: () => void;
}

/**
 * Shown when a drop is blocked because the BPF stage(s) the card is
 * leaving still have empty business-required fields. The card has NOT
 * been moved — this dialog only informs and offers to open the record.
 */
export const RequiredFieldsDialog: React.FC<RequiredFieldsDialogProps> = (props) => {
    const { recordTitle, targetStage, accentColor, missing, onOpenRecord, onClose } = props;

    const totalFields = missing.reduce((acc, m) => acc + m.fields.length, 0);

    return (
        <div className="dtk-modal__overlay">
            <div
                className="dtk-modal dtk-modal--blocked"
                role="alertdialog"
                aria-modal="true"
                aria-label="Move blocked — required fields missing"
            >
                <div
                    className="dtk-modal__header"
                    style={{ ["--dtk-accent" as string]: accentColor }}
                >
                    <div className="dtk-modal__header-top">
                        <div className="dtk-modal__header-left">
                            <span className="dtk-modal__icon dtk-modal__icon--warn">
                                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                    <path d="M12 9v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                    <path d="M12 16.5h.01" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                                    <path
                                        d="M10.3 4.1 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z"
                                        stroke="currentColor"
                                        strokeWidth="1.7"
                                        strokeLinejoin="round"
                                    />
                                </svg>
                            </span>
                            <div className="dtk-modal__titles">
                                <span className="dtk-modal__eyebrow">Move blocked</span>
                                <span className="dtk-modal__stage">Required fields missing</span>
                            </div>
                        </div>
                        <button
                            className="dtk-modal__close"
                            title="Close"
                            aria-label="Close"
                            onClick={onClose}
                        >
                            ✕
                        </button>
                    </div>
                    <div className="dtk-modal__subrow">
                        <span className="dtk-modal__record" title={recordTitle}>
                            {recordTitle}
                        </span>
                        <span className="dtk-modal__progress-pill">
                            {totalFields} field{totalFields === 1 ? "" : "s"} required
                        </span>
                    </div>
                </div>

                <div className="dtk-modal__body">
                    <p className="dtk-blocked__intro">
                        This record can&apos;t move to <strong>{targetStage}</strong> yet.
                        Please fill the required field{totalFields === 1 ? "" : "s"} below,
                        then try again.
                    </p>
                    {missing.map((group) => (
                        <div className="dtk-blocked__group" key={group.stage}>
                            <div className="dtk-blocked__stage">{group.stage}</div>
                            <ul className="dtk-blocked__fields">
                                {group.fields.map((f) => (
                                    <li className="dtk-blocked__field" key={f}>
                                        <span className="dtk-blocked__bullet" aria-hidden="true">
                                            !
                                        </span>
                                        {f}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                <div className="dtk-modal__footer">
                    <span className="dtk-modal__status dtk-modal__status--warn">
                        The card stays in its current stage.
                    </span>
                    <div className="dtk-modal__actions">
                        <button className="dtk-modal__btn dtk-modal__btn--ghost" onClick={onClose}>
                            Close
                        </button>
                        <button
                            className="dtk-modal__btn dtk-modal__btn--primary"
                            style={{ ["--dtk-accent" as string]: accentColor }}
                            onClick={() => {
                                onOpenRecord();
                                onClose();
                            }}
                        >
                            Open record
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};