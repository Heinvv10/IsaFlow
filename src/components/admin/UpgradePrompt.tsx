/**
 * UpgradePrompt
 * Shown when a feature is gated by the FeatureGate component.
 */

interface UpgradePromptProps {
  feature: string;
}

export function UpgradePrompt({ feature }: UpgradePromptProps) {
  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20 p-6 text-center">
      <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-100 mb-2">
        Upgrade Required
      </h3>
      <p className="text-blue-700 dark:text-blue-300 mb-4">
        This feature requires a higher plan. Contact your administrator to upgrade.
      </p>
      <span className="inline-block px-3 py-1 bg-blue-100 dark:bg-blue-800 rounded text-sm text-blue-800 dark:text-blue-200">
        Feature: {feature}
      </span>
    </div>
  );
}
