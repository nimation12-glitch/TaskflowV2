export const ROADMAP_ITEMS = [
  { title: "AI Model Gateway", description: "Pay-per-token access to hosted AI models, returning soon." },
  { title: "Multi-GPU instances", description: "For training jobs needing more than one GPU at once." },
  { title: "Persistent storage volumes", description: "Carry your data across separate rentals instead of losing it when you terminate." },
  { title: "Environment templates", description: "One-click pre-configured images (PyTorch, TensorFlow, ComfyUI, etc.) instead of a bare Ubuntu box." },
  { title: "Team-shared rentals", description: "Let teammates access the same running GPU instance." },
  { title: "Additional regions", description: "Currently US-only (us-east-1) — more regions planned based on demand." },
] as const;
