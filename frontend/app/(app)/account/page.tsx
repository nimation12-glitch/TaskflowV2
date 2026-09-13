import { auth } from "@/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { getThemePreference } from "@/lib/theme";
import { ProfileSection, AppearanceSection } from "./account-client";
import { ROADMAP_ITEMS } from "@/lib/roadmap";

export default async function AccountPage() {
  const session = await auth();
  const theme = await getThemePreference(session?.user?.id);

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">Manage your profile, appearance, and see what's coming next.</p>

      <Tabs defaultValue="profile" className="mt-6">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
          <TabsTrigger value="roadmap">Roadmap</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="mt-6">
          <ProfileSection name={session?.user?.name ?? ""} email={session?.user?.email ?? "—"} />
        </TabsContent>

        <TabsContent value="appearance" className="mt-6">
          <AppearanceSection initialPreference={theme} />
        </TabsContent>

        <TabsContent value="roadmap" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Roadmap</CardTitle>
              <CardDescription>What we're building next.</CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-border">
                {ROADMAP_ITEMS.map((item) => (
                  <li key={item.title} className="py-3 first:pt-0 last:pb-0">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{item.description}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
