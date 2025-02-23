import { Box, Flex, Icon, Link } from '@chakra-ui/react';
import { MdAlbum, MdHome, MdPhoto, MdSearch, MdSettings } from 'react-icons/md';
import { Link as RouterLink } from 'react-router-dom';

const Navigation = () => {
  return (
    <Box bg="teal.500" px={4} position="sticky" top={0} zIndex={1}>
      <Flex h={16} alignItems="center" justifyContent="space-between">
        <Flex alignItems="center" gap={8}>
          <Link
            as={RouterLink}
            to="/"
            fontSize="xl"
            fontWeight="bold"
            color="white"
          >
            PixdeX
          </Link>

          <Flex gap={4}>
            <Link
              as={RouterLink}
              to="/"
              color="white"
              display="flex"
              alignItems="center"
            >
              <Icon as={MdHome} mr={2} /> Dashboard
            </Link>
            <Link
              as={RouterLink}
              to="/albums"
              color="white"
              display="flex"
              alignItems="center"
            >
              <Icon as={MdAlbum} mr={2} /> Albums
            </Link>
            <Link
              as={RouterLink}
              to="/search"
              color="white"
              display="flex"
              alignItems="center"
            >
              <Icon as={MdSearch} mr={2} /> Search
            </Link>
            <Link
              as={RouterLink}
              to="/daily"
              color="white"
              display="flex"
              alignItems="center"
            >
              <Icon as={MdPhoto} mr={2} /> Daily Pick
            </Link>
            <Link
              as={RouterLink}
              to="/settings"
              color="white"
              display="flex"
              alignItems="center"
            >
              <Icon as={MdSettings} mr={2} /> Settings
            </Link>
          </Flex>
        </Flex>
      </Flex>
    </Box>
  );
};

export default Navigation;
