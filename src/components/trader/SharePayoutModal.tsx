import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Copy, Twitter, Check, Loader2, ExternalLink, Gift } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { generateShortId, publicShareUrl } from "@/lib/share-utils";
import { toast } from "sonner";

interface SharePayoutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  payoutId: string;
  amount: number;
}

export function SharePayoutModal({ open, onOpenChange, payoutId, amount }: SharePayoutModalProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [isPublic, setIsPublic] = useState(true);
  const [copied, setCopied] = useState(false);
  const [bonusUrl, setBonusUrl] = useState("");

  // Existing share row
  const { data: existing, isLoading } = useQuery({
    queryKey: ["payout-share", payoutId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payout_shares")
        .select("short_id, display_name, is_public")
        .eq("payout_id", payoutId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: open && !!payoutId,
  });

  const createShare = useMutation({
    mutationFn: async () => {
      const short_id = generateShortId();
      const { data, error } = await supabase
        .from("payout_shares")
        .insert({
          payout_id: payoutId,
          short_id,
          display_name: displayName.trim() || null,
          is_public: isPublic,
        })
        .select("short_id, display_name, is_public")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payout-share", payoutId] });
      toast.success("Share link created");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to create share"),
  });

  const togglePublic = useMutation({
    mutationFn: async (next: boolean) => {
      const { error } = await supabase
        .from("payout_shares")
        .update({ is_public: next })
        .eq("payout_id", payoutId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["payout-share", payoutId] }),
  });

  const claimBonus = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error("Not signed in");
      const { error } = await supabase.from("payout_share_bonuses").insert({
        payout_id: payoutId,
        user_id: user.id,
        post_url: bonusUrl.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setBonusUrl("");
      toast.success("Bonus claim submitted — admin will review within 24h");
    },
    onError: (e: Error) => toast.error(e.message || "Failed to submit"),
  });

  const shareUrl = existing ? publicShareUrl(existing.short_id) : "";
  const tweetText = `Just got paid $${amount.toLocaleString()} from @meridian — verified payout: ${shareUrl}`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Share your ${amount.toLocaleString()} payout</DialogTitle>
          <DialogDescription>
            Get a public verified-payout page you can post anywhere.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : !existing ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="display-name">Display name (optional)</Label>
              <Input
                id="display-name"
                placeholder="e.g. trader_jane or your @handle"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={40}
              />
              <p className="text-xs text-muted-foreground">Leave blank to appear as "Anonymous Trader"</p>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="is-public">Make public</Label>
                <p className="text-xs text-muted-foreground">You can turn this off anytime</p>
              </div>
              <Switch id="is-public" checked={isPublic} onCheckedChange={setIsPublic} />
            </div>
            <Button
              onClick={() => createShare.mutate()}
              disabled={createShare.isPending}
              className="w-full"
            >
              {createShare.isPending ? "Creating…" : "Create share link"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Your public link</Label>
              <div className="flex gap-2">
                <Input value={shareUrl} readOnly className="font-mono text-xs" />
                <Button size="icon" variant="outline" onClick={handleCopy} aria-label="Copy">
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Button asChild variant="outline" size="sm">
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Twitter className="h-4 w-4 mr-2" />
                  Tweet
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={shareUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Preview
                </a>
              </Button>
            </div>

            <div className="flex items-center justify-between rounded-md border border-border p-3">
              <Label htmlFor="toggle-public" className="text-sm">Public</Label>
              <Switch
                id="toggle-public"
                checked={existing.is_public}
                onCheckedChange={(v) => togglePublic.mutate(v)}
              />
            </div>

            <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Gift className="h-4 w-4 text-primary" />
                Earn a $25 share bonus
              </div>
              <p className="text-xs text-muted-foreground">
                Post your payout publicly (Twitter, Discord, YouTube). Paste the URL below; we'll
                verify and credit $25 to your next payout.
              </p>
              <div className="flex gap-2">
                <Input
                  placeholder="https://twitter.com/you/status/…"
                  value={bonusUrl}
                  onChange={(e) => setBonusUrl(e.target.value)}
                  className="text-xs"
                />
                <Button
                  size="sm"
                  onClick={() => claimBonus.mutate()}
                  disabled={!bonusUrl.trim() || claimBonus.isPending}
                >
                  Submit
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}