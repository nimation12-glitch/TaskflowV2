import { auth } from "@/auth";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getThemePreference } from "@/lib/theme";
import { ProfileSection, AppearanceSection } from "./account-client";

export default async function AccountPage() {
  const session = await auth();
  const theme = await getThemePreference(session?.user?.id);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Manage your profile and appearance.</p>

      <Tabs defaultValue="profile" className="mt-6">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-6">
          <ProfileSection name={session?.user?.name ?? ""} email={session?.user?.email ?? "—"} />
        </TabsContent>

        <TabsContent value="appearance" className="mt-6">
          <AppearanceSection initialPreference={theme} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
