import Image from "next/image";

export function TribesMark({
  alt = "Tribes",
  className = "size-6",
  priority = false,
}: {
  alt?: string;
  className?: string;
  priority?: boolean;
}) {
  return (
    <>
      <Image
        src="/tribes-mark-light.png"
        alt={alt}
        width={512}
        height={512}
        sizes="48px"
        priority={priority}
        className={`shrink-0 dark:hidden ${className}`}
      />
      <Image
        src="/tribes-mark-dark.png"
        alt={alt}
        width={512}
        height={512}
        sizes="48px"
        priority={priority}
        className={`hidden shrink-0 dark:block ${className}`}
      />
    </>
  );
}
