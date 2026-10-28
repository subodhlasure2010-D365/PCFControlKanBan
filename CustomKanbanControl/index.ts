import * as React from "react";
import * as ReactDOM from "react-dom";
import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { App } from "./components/App";

export class CustomKanbanControl implements ComponentFramework.StandardControl<IInputs, IOutputs> {
    private container: HTMLDivElement;

    /**
     * Called once when the control is initialized.
     */
    public init(
        context: ComponentFramework.Context<IInputs>,
        _notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary,
        container: HTMLDivElement
    ): void {
        this.container = container;
        this.container.style.width = "100%";
        this.container.style.height = "100%";
        context.mode.trackContainerResize(true);
    }

    /**
     * Called when any value in the property bag changes (dataset load,
     * paging, resize, etc). Re-renders the React tree.
     */
    public updateView(context: ComponentFramework.Context<IInputs>): void {
        const ownerColumn = context.parameters.ownerColumn?.raw ?? "ownerid";
        const boardHeight = context.parameters.boardHeight?.raw ?? 720;
        const validateBpf = (context.parameters.validateBpf?.raw ?? "yes") !== "no";

        ReactDOM.render(
            React.createElement(App, {
                context: context as unknown as ComponentFramework.Context<unknown>,
                dataset: context.parameters.records,
                ownerColumn: ownerColumn || "ownerid",
                boardHeight: boardHeight && boardHeight > 0 ? boardHeight : 720,
                validateBpf,
            }),
            this.container
        );
    }

    public getOutputs(): IOutputs {
        return {};
    }

    public destroy(): void {
        ReactDOM.unmountComponentAtNode(this.container);
    }
}