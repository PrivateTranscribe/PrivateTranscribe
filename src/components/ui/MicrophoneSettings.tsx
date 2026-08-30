import React from "react";
import { SettingsRow } from "./SettingsSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select";
import MicrophoneDeviceSelect from "./MicrophoneDeviceSelect";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { DEFAULT_MIC_WARM_WINDOW_SECONDS } from "../../utils/micWarmWindow";

interface MicrophoneSettingsProps {
  preferBuiltInMic: boolean;
  selectedMicDeviceId: string;
  onPreferBuiltInChange: (value: boolean) => void;
  onDeviceSelect: (deviceId: string) => void;
}

export const MicrophoneSettings: React.FC<MicrophoneSettingsProps> = ({
  preferBuiltInMic,
  selectedMicDeviceId,
  onPreferBuiltInChange,
  onDeviceSelect,
}) => {
  const [micWarmWindowSeconds, setMicWarmWindowSeconds] = useLocalStorage<number>(
    "micWarmWindowSeconds",
    DEFAULT_MIC_WARM_WINDOW_SECONDS,
    {
      serialize: String,
      deserialize: (value) => {
        const num = parseInt(value, 10);
        if (!Number.isFinite(num) || num < 0) return DEFAULT_MIC_WARM_WINDOW_SECONDS;
        return num;
      },
    }
  );

  return (
    <div className="space-y-4">
      <SettingsRow
        label="Microphone"
        description="The input dictation records from. Automatic prefers a built-in mic over anything plugged in; pick a device by name to pin it."
      >
        <MicrophoneDeviceSelect
          className="w-[300px]"
          preferBuiltInMic={preferBuiltInMic}
          selectedMicDeviceId={selectedMicDeviceId}
          onChange={(next) => {
            onPreferBuiltInChange(next.preferBuiltInMic);
            onDeviceSelect(next.selectedMicDeviceId);
          }}
        />
      </SettingsRow>

      <SettingsRow
        label="Keep microphone ready"
        description="Hold the mic open briefly after dictation so the next hotkey press starts instantly instead of waiting for the mic to wake up. Longer avoids the cold-start lag but keeps the system mic-in-use indicator on longer. Audio is never recorded or sent while idle."
      >
        <Select
          value={String(micWarmWindowSeconds)}
          onValueChange={(value) => setMicWarmWindowSeconds(parseInt(value, 10))}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="15">15 seconds</SelectItem>
            <SelectItem value="30">30 seconds</SelectItem>
            <SelectItem value="60">1 minute</SelectItem>
            <SelectItem value="120">2 minutes</SelectItem>
            <SelectItem value="0">Always ready</SelectItem>
          </SelectContent>
        </Select>
      </SettingsRow>
    </div>
  );
};

export default MicrophoneSettings;
