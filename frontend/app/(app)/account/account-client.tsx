"use client";

import { useState } from "react";
import { LogOut, Sun, Moon, Monitor, Pencil } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useAction } from "@/lib/hooks/use-action";
import { setThemePreferenceAction, updateNameAction } from "./actions";
import type { ThemePreference } from "@/lib/theme";

export function ProfileSection({ name, email }: { name: string; email: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const { pending, run } = useAction();

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    run(() => updateNameAction(value), {
      success: "Name updated",
      error: "Couldn't update your name",
      onSuccess: () => setEditing(false),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Profile</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <Label>Name</Label>
          {editing ? (
            <form onSubmit={handleSave} className="mt-1.5 flex gap-2">
              <Input value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
              <Button type="submit" size="sm" loading={pending} disabled={!value.trim()}>
                Save
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="mt-1.5 flex items-center gap-2">
              <p className="text-sm">{name || "—"}</p>
              <button onClick={() => setEditing(true)} className="text-muted-foreground transition-colors hover:text-foreground">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
        <div>
          <Label>Email</Label>
          <p className="mt-1.5 text-sm">{email}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">Rental times are shown in your browser's local timezone.</p>
        </div>
        <div className="border-t border-border pt-4">
          <Button variant="secondary" size="sm" onClick={() => signOut({ redirectTo: "/login" })}>
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export function AppearanceSection({ initialPreference }: { initialPreference: ThemePreference }) {
  const [preference, setPreference] = useState(initialPreference);
  const { pending, run } = useAction();

  function handleSelect(value: ThemePreference) {
    setPreference(value);
    run(() => setThemePreferenceAction(value), { error: "Couldn't update theme" });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Appearance</CardTitle>
        <CardDescription>Applies to your account everywhere you're signed in — not stored in this browser.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3">
          {THEME_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = preference === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => handleSelect(opt.value)}
                disabled={pending}
                className={`flex flex-col items-center gap-2 rounded-md border p-4 text-sm transition-colors disabled:opacity-60 ${
                  active ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="h-5 w-5" />
                {opt.label}
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
