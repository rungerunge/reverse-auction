import { json } from "@remix-run/node";
import { useLoaderData, useSubmit, Form } from "@remix-run/react";
import { Page, Layout, Card, Button, TextField, BlockStack, Checkbox, Text } from "@shopify/polaris";
import { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: { request: Request }) => {
  const { admin, session } = await authenticate.admin(request);
  const config = await prisma.auctionConfig.findUnique({
    where: { shop: session.shop },
  });

  return json({ config: config || {} });
};

export const action = async ({ request }: { request: Request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const startTime = new Date(formData.get("startTime") as string);
  const dropIntervalMinutes = parseInt(formData.get("dropIntervalMinutes") as string);
  const dropPercentage = parseFloat(formData.get("dropPercentage") as string);
  const maxDiscount = parseFloat(formData.get("maxDiscount") as string);
  const startDiscount = parseFloat(formData.get("startDiscount") as string);
  const isActive = formData.get("isActive") === "true";

  await prisma.auctionConfig.upsert({
    where: { shop: session.shop },
    update: {
      startTime,
      dropIntervalMinutes,
      dropPercentage,
      maxDiscount,
      startDiscount,
      isActive,
    },
    create: {
      shop: session.shop,
      startTime,
      dropIntervalMinutes,
      dropPercentage,
      maxDiscount,
      startDiscount,
      isActive,
    },
  });

  return json({ status: "success" });
};

export default function Index() {
  const { config } = useLoaderData<typeof loader>();
  const submit = useSubmit();

  const [formState, setFormState] = useState({
    startTime: config.startTime ? new Date(config.startTime).toISOString().slice(0, 16) : "",
    dropIntervalMinutes: config.dropIntervalMinutes || 30,
    dropPercentage: config.dropPercentage || 5,
    maxDiscount: config.maxDiscount || 75,
    startDiscount: config.startDiscount || 20,
    isActive: config.isActive || false,
  });

  const handleSave = () => {
    submit(formState, { method: "post" });
  };

  return (
    <Page title="Reverse Auction Settings">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Configuration
              </Text>
              <Form method="post">
                <BlockStack gap="400">
                  <TextField
                    label="Start Time"
                    type="datetime-local"
                    value={formState.startTime}
                    onChange={(value) => setFormState({ ...formState, startTime: value })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Drop Interval (Minutes)"
                    type="number"
                    value={String(formState.dropIntervalMinutes)}
                    onChange={(value) => setFormState({ ...formState, dropIntervalMinutes: parseInt(value) })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Drop Percentage (%)"
                    type="number"
                    value={String(formState.dropPercentage)}
                    onChange={(value) => setFormState({ ...formState, dropPercentage: parseFloat(value) })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Max Discount (%)"
                    type="number"
                    value={String(formState.maxDiscount)}
                    onChange={(value) => setFormState({ ...formState, maxDiscount: parseFloat(value) })}
                    autoComplete="off"
                  />
                  <TextField
                    label="Start Discount (%)"
                    type="number"
                    value={String(formState.startDiscount)}
                    onChange={(value) => setFormState({ ...formState, startDiscount: parseFloat(value) })}
                    autoComplete="off"
                  />
                  <Checkbox
                    label="Activate Auction"
                    checked={formState.isActive}
                    onChange={(newChecked) => setFormState({ ...formState, isActive: newChecked })}
                  />
                  <Button onClick={handleSave} variant="primary">
                    Save Settings
                  </Button>
                </BlockStack>
              </Form>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
