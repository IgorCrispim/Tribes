import Image from "next/image";

export function TribesLogo({
  alt = "Tribes — Comunidade e Natureza",
  className = "h-9 w-auto",
  priority = false,
}: {
  alt?: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <span className="inline-flex h-10 w-[7.25rem] shrink-0 items-center justify-center">
      <Image
        src="/tribes-logo-light.png"
        alt={alt}
        width={1255}
        height={472}
        sizes="96px"
        priority={priority}
        className={`mx-auto shrink-0 dark:hidden ${className}`}
      />
      <Image
        src="/tribes-logo-dark.png"
        alt={alt}
        width={1255}
        height={472}
        sizes="96px"
        priority={priority}
        className={`mx-auto hidden shrink-0 dark:block ${className}`}
      />
    </span>
  );
}
