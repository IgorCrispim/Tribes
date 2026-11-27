import type { Metadata } from "next";
import { PartnerParticipantClaim } from "@/components/social/partner-participant-claim";

export const metadata: Metadata = {
  title: "Resgatar ingresso | Tribes",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function RedeemPartnerParticipantPage() {
  return <PartnerParticipantClaim />;
}
