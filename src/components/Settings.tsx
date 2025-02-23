import {
  Box,
  Button,
  Card,
  CardBody,
  CardHeader,
  Divider,
  FormControl,
  FormLabel,
  Heading,
  Input,
  Select,
  Switch,
  useToast,
  VStack,
} from '@chakra-ui/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { apiClient } from '../services/api/ApiClient';
import { AppConfig, LLMProvider } from '../types/config';

const Settings = () => {
  const [config, setConfig] = useState<AppConfig>({
    llm: {
      provider: 'openai',
      apiKey: '',
    },
    storage: {
      localPaths: [],
      googleDrive: {
        enabled: false,
        credentialsPath: '',
      },
    },
    chromaDbPath: './data/chromadb',
    cacheDir: './data/cache',
  });

  const toast = useToast();

  const { data: savedConfig, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => apiClient.getConfig(),
  });

  useEffect(() => {
    if (savedConfig) {
      setConfig(savedConfig);
    }
  }, [savedConfig]);

  const updateConfigMutation = useMutation({
    mutationFn: (newConfig: AppConfig) => apiClient.updateConfig(newConfig),
    onSuccess: () => {
      toast({
        title: 'Settings saved',
        status: 'success',
        duration: 2000,
      });
    },
    onError: (error) => {
      toast({
        title: 'Error saving settings',
        description:
          error instanceof Error ? error.message : 'An error occurred',
        status: 'error',
        duration: 3000,
      });
    },
  });

  const handleSave = () => {
    updateConfigMutation.mutate(config);
  };

  if (isLoading) {
    return <Box>Loading...</Box>;
  }

  return (
    <Box w="100%" maxW="container.xl" mx="auto">
      <Card>
        <CardHeader>
          <Heading size="md">Settings</Heading>
        </CardHeader>
        <CardBody>
          <VStack spacing={6} align="stretch">
            <Box>
              <Heading size="sm" mb={4}>
                LLM Configuration
              </Heading>
              <VStack spacing={4}>
                <FormControl id="llm-provider">
                  <FormLabel>LLM Provider</FormLabel>
                  <Select
                    aria-label="Select LLM Provider"
                    name="llm-provider"
                    value={config.llm.provider}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        llm: {
                          ...config.llm,
                          provider: e.target.value as LLMProvider,
                        },
                      })
                    }
                  >
                    <option value="openai">OpenAI</option>
                    <option value="grok3">Grok3</option>
                  </Select>
                </FormControl>
                <FormControl>
                  <FormLabel htmlFor="api-key">API Key</FormLabel>
                  <Input
                    id="api-key"
                    type="password"
                    value={config.llm.apiKey}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        llm: { ...config.llm, apiKey: e.target.value },
                      })
                    }
                  />
                </FormControl>
              </VStack>
            </Box>

            <Divider />

            <Box>
              <Heading size="sm" mb={4}>
                Storage Configuration
              </Heading>
              <VStack spacing={4}>
                <FormControl>
                  <FormLabel htmlFor="local-paths">
                    Local Photo Directories
                  </FormLabel>
                  <Input
                    id="local-paths"
                    placeholder="Comma-separated paths"
                    value={config.storage.localPaths.join(',')}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        storage: {
                          ...config.storage,
                          localPaths: e.target.value
                            .split(',')
                            .map((p) => p.trim()),
                        },
                      })
                    }
                  />
                </FormControl>
                <FormControl display="flex" alignItems="center">
                  <FormLabel htmlFor="enable-google-drive" mb={0}>
                    Enable Google Drive
                  </FormLabel>
                  <Switch
                    id="enable-google-drive"
                    isChecked={config.storage.googleDrive.enabled}
                    onChange={(e) =>
                      setConfig({
                        ...config,
                        storage: {
                          ...config.storage,
                          googleDrive: {
                            ...config.storage.googleDrive,
                            enabled: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                </FormControl>
                {config.storage.googleDrive.enabled && (
                  <FormControl>
                    <FormLabel htmlFor="google-drive-credentials">
                      Google Drive Credentials Path
                    </FormLabel>
                    <Input
                      id="google-drive-credentials"
                      value={config.storage.googleDrive.credentialsPath}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          storage: {
                            ...config.storage,
                            googleDrive: {
                              ...config.storage.googleDrive,
                              credentialsPath: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </FormControl>
                )}
              </VStack>
            </Box>

            <Button
              colorScheme="teal"
              onClick={handleSave}
              isLoading={updateConfigMutation.isPending}
            >
              Save Settings
            </Button>
          </VStack>
        </CardBody>
      </Card>
    </Box>
  );
};

export default Settings;
