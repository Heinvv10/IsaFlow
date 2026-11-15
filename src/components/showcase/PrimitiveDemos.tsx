/**
 * Component showcase: the primitives (Button, Input, Badge, Card, Tooltip, LoadingSpinner), every variant and state.
 */
import { useState } from 'react';
import { Button, Input, Badge, Card, Tooltip, LoadingSpinner } from '@/components/ui';
import { Download, Plus, Trash2, Search, Mail, Eye, CheckCircle } from 'lucide-react';
import { useTimeoutOnce } from '@/hooks/useTimeoutOnce';
import { Row, Section } from './ShowcaseSection';

export function PrimitiveDemos() {
  const [loadingDemo, setLoadingDemo] = useState(false);
  const afterDelay = useTimeoutOnce();

  const simulateLoading = () => {
    setLoadingDemo(true);
    afterDelay(() => setLoadingDemo(false), 2000);
  };

  return (
    <>
      {/* ── Button ── */}
      <Section id="Button" title="Button" description="Primary interactive element. Supports variants, sizes, icons, and loading state.">
        <Row label="Variants">
          <Button variant="primary">Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
        </Row>
        <Row label="Sizes">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </Row>
        <Row label="With icons">
          <Button leftIcon={Plus} size="sm">New Invoice</Button>
          <Button rightIcon={Download}>Export</Button>
          <Button variant="danger" leftIcon={Trash2}>Delete</Button>
        </Row>
        <Row label="States">
          <Button disabled>Disabled</Button>
          <Button loading={loadingDemo} onClick={simulateLoading}>
            {loadingDemo ? 'Saving…' : 'Save (click me)'}
          </Button>
        </Row>
      </Section>

      {/* ── Input ── */}
      <Section id="Input" title="Input" description="Form text field with label, validation states, helper text, and icon slots.">
        <Row label="Variants">
          <div className="w-56"><Input label="Default" placeholder="Enter value" /></div>
          <div className="w-56"><Input label="Error state" inputVariant="error" defaultValue="bad@" error="Invalid email address" /></div>
          <div className="w-56"><Input label="Success state" inputVariant="success" defaultValue="valid@example.com" helperText="Email looks good" /></div>
        </Row>
        <Row label="Sizes">
          <div className="w-44"><Input size="sm" placeholder="Small" /></div>
          <div className="w-44"><Input size="md" placeholder="Medium" /></div>
          <div className="w-44"><Input size="lg" placeholder="Large" /></div>
        </Row>
        <Row label="With icons">
          <div className="w-56"><Input label="Search" leftIcon={Search} placeholder="Search invoices…" /></div>
          <div className="w-56"><Input label="Email" leftIcon={Mail} rightIcon={Eye} placeholder="user@example.com" /></div>
        </Row>
      </Section>

      {/* ── Badge ── */}
      <Section id="Badge" title="Badge" description="Status indicator pill. Used for invoice status, payment states, and flags.">
        <Row label="Variants">
          <Badge variant="default">Draft</Badge>
          <Badge variant="success">Paid</Badge>
          <Badge variant="warning">Pending</Badge>
          <Badge variant="danger">Overdue</Badge>
          <Badge variant="info">In Review</Badge>
          <Badge variant="neutral">Archived</Badge>
        </Row>
        <Row label="With dot indicator">
          <Badge variant="success" dot>Paid</Badge>
          <Badge variant="danger" dot>Overdue</Badge>
          <Badge variant="warning" dot>Pending</Badge>
        </Row>
        <Row label="Sizes">
          <Badge size="sm">Small</Badge>
          <Badge size="md">Medium</Badge>
        </Row>
      </Section>

      {/* ── Card ── */}
      <Section id="Card" title="Card" description="Surface container with header, body, and footer slots. Supports hover variant.">
        <Row label="Basic card">
          <Card className="w-72" header={<p className="font-semibold text-gray-900 dark:text-gray-100">Invoice Summary</p>}>
            <p className="text-sm text-gray-600 dark:text-gray-400">Total outstanding: R 12,450.00</p>
          </Card>
        </Row>
        <Row label="With compound components">
          <Card className="w-72" noPadding>
            <Card.Header title="Sales Report" description="Last 30 days" action={<Badge variant="success">Live</Badge>} />
            <Card.Body>
              <p className="text-sm text-gray-600 dark:text-gray-400">Revenue: R 84,200</p>
            </Card.Body>
            <Card.Footer>
              <p className="text-xs text-gray-600 dark:text-gray-400">Updated just now</p>
            </Card.Footer>
          </Card>
        </Row>
        <Row label="Hoverable">
          <Card className="w-64" hoverable>
            <p className="text-sm text-gray-700 dark:text-gray-300">Click me — I am hoverable</p>
          </Card>
        </Row>
      </Section>

      {/* ── Tooltip ── */}
      <Section id="Tooltip" title="Tooltip" description="CSS-only hover tooltip. No external dependencies. 300 ms reveal delay.">
        <Row label="Positions">
          <Tooltip content="Top tooltip" position="top"><Button variant="secondary" size="sm">Top</Button></Tooltip>
          <Tooltip content="Bottom tooltip" position="bottom"><Button variant="secondary" size="sm">Bottom</Button></Tooltip>
          <Tooltip content="Left tooltip" position="left"><Button variant="secondary" size="sm">Left</Button></Tooltip>
          <Tooltip content="Right tooltip" position="right"><Button variant="secondary" size="sm">Right</Button></Tooltip>
        </Row>
        <Row label="On icon buttons">
          <Tooltip content="Download report">
            <Button variant="ghost" size="sm"><Download size={16} /></Button>
          </Tooltip>
          <Tooltip content="Mark as paid" position="right">
            <Button variant="ghost" size="sm"><CheckCircle size={16} /></Button>
          </Tooltip>
        </Row>
      </Section>

      {/* ── LoadingSpinner ── */}
      <Section id="Loading" title="LoadingSpinner" description="Lightweight CSS spinner for async state indicators.">
        <Row label="Sizes">
          <LoadingSpinner size="sm" />
          <LoadingSpinner size="md" />
          <LoadingSpinner size="lg" />
        </Row>
      </Section>
    </>
  );
}
