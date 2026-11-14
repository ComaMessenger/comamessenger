import { View } from "react-native";
import { BottomSheet } from "./BottomSheet";
import { ChoiceRow, Divider } from "./Settings";

export type PickerOption<T extends string> = { value: T; label: string };

/** Bottom sheet to pick one value; the current one carries a check mark. */
export function PickerSheet<T extends string>({
  visible,
  title,
  value,
  options,
  onSelect,
  onClose,
  testID,
}: {
  visible: boolean;
  title: string;
  value: T;
  options: PickerOption<T>[];
  onSelect(value: T): void;
  onClose(): void;
  testID?: string;
}) {
  return (
    <BottomSheet
      visible={visible}
      title={title}
      onClose={onClose}
      testID={testID}
    >
      {options.map((option, index) => (
        <View key={option.value}>
          {index > 0 && <Divider />}
          <ChoiceRow
            testID={testID ? `${testID}-${option.value}` : undefined}
            label={option.label}
            selected={option.value === value}
            onPress={() => {
              onClose();
              onSelect(option.value);
            }}
          />
        </View>
      ))}
    </BottomSheet>
  );
}
