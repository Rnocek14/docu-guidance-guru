import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Loader2, Shield } from "lucide-react";
import { toast } from "sonner";

const CODE_RE = /^[A-Z0-9_-]{3,32}$/;

export default function AffiliateApply() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [payoutMethod, setPayoutMethod] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(true);
  const [existing, setExisting] = useState<{ status: string; code: string } | null>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data } = await supabase
        .from("affiliates")
        .select("status, code")
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) setExisting(data as { status: string; code: string });
      setChecking(false);
    })();
  }, [user]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const normalized = code.trim().toUpperCase();
    if (!CODE_RE.test(normalized)) {
      toast.error("Code must be 3–32 chars, A–Z, 0–9, _ or -");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("apply_for_affiliate", {
      p_code: normalized,
      p_payout_method: payoutMethod || null,
    });
    setSubmitting(false);
    if (error) {
      if (error.message.includes("CODE_OR_USER_TAKEN")) {
        toast.error("That code is taken, or you already applied.");
      } else {
        toast.error(error.message);
      }
      return;
    }
    toast.success("Application submitted. We'll review shortly.");
    navigate("/affiliate/dashboard");
  };

  return (
    <div className="min-h-screen bg-background flex items-start justify-center py-16 px-4">
      <div className="max-w-xl w-full">
        <div className="flex items-center gap-2 mb-8">
          <Shield className="h-6 w-6 text-primary" />
          <span className="text-lg font-bold">Meridian Affiliate Program</span>
        </div>

        {checking ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : existing ? (
          <Card>
            <CardHeader>
              <CardTitle>You've already applied</CardTitle>
              <CardDescription>
                Code <span className="font-mono">{existing.code}</span> · status{" "}
                <span className="capitalize">{existing.status}</span>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild>
                <Link to="/affiliate/dashboard">Go to dashboard</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Apply to become an affiliate</CardTitle>
              <CardDescription>
                Earn <strong>25%</strong> on initial purchases and <strong>10%</strong> on reset purchases for
                30 days from each click. Manually approved.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="code">Referral code</Label>
                  <Input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="YOURHANDLE"
                    maxLength={32}
                    autoComplete="off"
                  />
                  <p className="text-xs text-muted-foreground">
                    3–32 chars · A–Z, 0–9, _ or - · case-insensitive
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="payout">Payout method (PayPal email, Wise, etc.)</Label>
                  <Textarea
                    id="payout"
                    value={payoutMethod}
                    onChange={(e) => setPayoutMethod(e.target.value)}
                    placeholder="e.g. PayPal: you@example.com"
                    rows={3}
                  />
                </div>
                <Alert>
                  <AlertDescription className="text-xs">
                    Self-referrals are blocked automatically. Coupon abuse, fake traffic, or spam will result
                    in suspension and forfeit of pending commissions.
                  </AlertDescription>
                </Alert>
                <Button type="submit" disabled={submitting || !code} className="w-full">
                  {submitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Submit application
                </Button>
              </form>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}