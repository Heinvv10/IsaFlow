# Independent review

Reviewer review_delegation found one blocking P2 at09274745 against8ef36111: fractional default remaining quantity used floating subtraction. Order0.30 less received0.10 became0.19999999999999998, rejected by the server precision guard. Actual browser regression reproduced400. The form now calculates default and max using integer hundredths and exposes step0.01. The same browser case now posts0.10 then default0.20 and reconciles receipt/PO totals0.30. Server precision rejection remains intact. Review followup pending; initial fullCI run was interrupted before source edits, not counted as acceptance.

Followup review approved f2fd9243 against09274745 with no further blocking findings; default/max hundredths, fractional browser/SQL proof and preserved server precision confirmed. Reviewer did not rerun tests.
