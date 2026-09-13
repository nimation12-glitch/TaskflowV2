import { getSystemStatus } from "@/lib/system-client";
import { MaintenanceControls } from "./maintenance-controls";
import { UnavailableNotice } from "@/components/ui/unavailable-notice";
import { safe } from "@/lib/safe-fetch";

export default async function AdminMaintenancePage() {
  const { data: status, ok } = await safe(getSystemStatus(), { maintenance_mode_enabled: false, maintenance_message: null });

  if (!ok) {
    return <UnavailableNotice label="Maintenance status" />;
  }

  return (
    <MaintenanceControls
      initialEnabled={status.maintenance_mode_enabled}
      initialMessage={status.maintenance_message}
      updatedAt={null}
    />
  );
}
