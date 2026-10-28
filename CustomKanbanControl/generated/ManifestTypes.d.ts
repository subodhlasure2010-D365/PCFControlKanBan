/*
*This is auto generated from the ControlManifest.Input.xml file
*/

// Define IInputs and IOutputs Type. They should match with ControlManifest.
export interface IInputs {
    ownerColumn: ComponentFramework.PropertyTypes.StringProperty;
    validateBpf: ComponentFramework.PropertyTypes.EnumProperty<"yes" | "no">;
    boardHeight: ComponentFramework.PropertyTypes.WholeNumberProperty;
    records: ComponentFramework.PropertyTypes.DataSet;
}
export interface IOutputs {
}
